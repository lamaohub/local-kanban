
import { buildSelect, renderBoard, selVal } from './board.js';

const GENERIC_DEPLOY = 'deploy';
import { renderChaos } from './chaos.js';
import { $, ALL, AUTO, HEALTH, CALENDAR, CHAOS, DASH, DONE, HIDDEN_SECTIONS, HORIZON, NOW, REVIEW, SETTINGS, SIDEBAR_SECTIONS, addProjectPrompt, api, esc, ic, seg, setupPrompt, state, tr } from './core.js';
import { renderDashboard } from './dash.js';
import { renderCalendar, renderHorizon } from './horizon.js';
import { renderNow } from './now.js';
import { renderReview } from './review.js';
import { renderDone } from './done.js';
import { armedRules, automations, renderAutomations } from './automations.js';
import { renderHealth } from './health.js';
import { openProjectSettings, renderProjectSettings, skillOptions, deploySkills } from './project.js';
import { getSetting, openSettingsModal, plural } from './settings.js';
import { shareButtonHTML } from './share.js';
import { copyText, refresh, showView } from './sse.js';
import { errorLine, refusalLine } from './unsaved.js';
import { latestRequest, LIST_NOTICE, listErrorDelay, listFailure, listNotice, listRetry, sameScreen, SWITCH_SKELETON_MS } from './live-rules.js';
import { openSearch } from './search.js';
import { typeset } from './typeset.js';
import { localStore, sessionStore } from './store.js';

function sayProjectsFailed(e) {
  const box = $('projects');
  if (!box || box.querySelector('.proj')) return;
  box.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'board-note side-note';
  el.innerHTML = `<span>${esc(tr(e?.status
    ? 'The list of projects did not load: the server answered with an error. The board tries again by itself in a few seconds.'
    : 'The list of projects did not load: the server did not answer. The board tries again by itself in a few seconds.'))}</span><button type="button" class="btn-ghost board-note-retry">${esc(tr('Try now'))}</button>`;
  el.querySelector('button').onclick = () => { refresh().catch(() => {}); };
  box.appendChild(el);
}

export async function loadProjects() {
  try { state.projects = await api('GET', '/api/projects'); } catch (e) { if (!e?.aborted) sayProjectsFailed(e); throw e; }
  try { state.folders = await api('GET', '/api/projects/folders'); } catch {  }
  try { state.categories = await api('GET', '/api/categories'); } catch {  }
  const openable = [ALL, DASH, NOW, REVIEW, DONE, AUTO, HEALTH, SETTINGS, HORIZON, CALENDAR, CHAOS].filter((s) => !HIDDEN_SECTIONS.includes(s));
  if (!state.slug || (!openable.includes(state.slug) && !state.projects.find((p) => p.slug === state.slug))) {
    state.slug = state.projects[0]?.slug || DASH;
  }
  renderSidebar();
  renderTopbar();
}

const tasksRequest = latestRequest();
let shownScreen = null;
let pendingLoad = null; // { from: the screen the person stayed on, to: the screen that did not load }
const currentScreen = () => ({ slug: state.slug, settings: Boolean(state.projSettings && state.projSettings === state.slug) });
const SECTION_VIEW = { [DASH]: 'dashboard', [NOW]: 'now', [REVIEW]: 'review', [DONE]: 'done', [AUTO]: 'automations', [HEALTH]: 'health', [HORIZON]: 'horizon', [CALENDAR]: 'calendar', [CHAOS]: 'chaos' };
const viewOf = (screen) => (screen.settings ? 'projset' : SECTION_VIEW[screen.slug] || 'board');

export async function loadTasks() {
  if (state.slug === SETTINGS) state.slug = DASH;
  showSwitching(false);
  const special = [DASH, NOW, REVIEW, DONE, AUTO, HEALTH, HORIZON, CALENDAR, CHAOS].includes(state.slug) || (state.projSettings && state.projSettings === state.slug);
  if (special) { state.tasks = []; tasksRequest.start(); }
  if (special) screenShown(currentScreen());
  if (state.slug === DASH) { showView('dashboard'); await renderDashboard(); return; }
  if (state.slug === NOW) { showView('now'); await renderNow(); return; }
  if (state.slug === REVIEW) { showView('review'); await renderReview(); return; }
  if (state.slug === DONE) { showView('done'); await renderDone(); return; }
  if (state.slug === AUTO) { showView('automations'); await renderAutomations(); return; }
  if (state.slug === HEALTH) { showView('health'); await renderHealth(); return; }
  if (state.slug === HORIZON) { showView('horizon'); await renderHorizon(); return; }
  if (state.slug === CALENDAR) { showView('calendar'); await renderCalendar(); return; }
  if (state.slug === CHAOS) { const opening = showView('chaos'); await renderChaos(opening); return; }
  if (state.projSettings && state.projSettings === state.slug) {
    const opening = showView('projset');
    await renderProjectSettings(opening);
    return;
  }
  showView('board');
  if (!state.slug) { state.tasks = []; renderBoard(); return; }
  const q = state.search;
  const wanted = currentScreen();
  const req = tasksRequest.start();
  showSwitching(!sameScreen(shownScreen, wanted));
  let list;
  try {
    const qs = q ? `&q=${encodeURIComponent(q)}` : '';
    list = state.slug === ALL
      ? await api('GET', `/api/tasks?all=1${qs}`, undefined, { signal: req.signal })
      : await api('GET', `/api/tasks?project=${encodeURIComponent(state.slug)}&all=1${qs}`, undefined, { signal: req.signal });
  } catch (e) {
    if (tasksRequest.isLatest(req)) showSwitching(false);
    listFailed(e, tasksRequest.isLatest(req), wanted, q);
    return;
  }
  if (!tasksRequest.isLatest(req)) return;
  state.tasks = list;
  showSwitching(false);
  state.searchApplied = q;
  state.searchHits = q ? new Set(list.map((t) => t.id)) : null;
  screenShown(wanted);
  renderBoard();
}

// A screen is on the board now: what failed before it is settled, unless it is the switch still owed from here.
function screenShown(screen) {
  shownScreen = screen;
  state.listNote = null;
  if (screen.slug && screen.slug !== ALL && !screen.slug.startsWith('#')) localStore.setItem('kb.ui.lastProject', screen.slug);
  if (pendingLoad && (sameScreen(pendingLoad.to, screen) || !sameScreen(pendingLoad.from, screen))) { pendingLoad = null; showLoadNotice(null); retryNoMore(); }
}

let switchTimer = null;
function showSwitching(on) {
  clearTimeout(switchTimer);
  switchTimer = null;
  document.documentElement.classList.remove('switching');
  if (on) switchTimer = setTimeout(() => { switchTimer = null; document.documentElement.classList.add('switching'); }, SWITCH_SKELETON_MS);
}

let errorRetry = { timer: null, n: 0 };
function retryLater() {
  clearTimeout(errorRetry.timer);
  errorRetry.timer = setTimeout(() => { errorRetry.timer = null; retryLoad(); }, listErrorDelay(errorRetry.n));
  errorRetry.n += 1;
}
function retryNoMore() {
  clearTimeout(errorRetry.timer);
  errorRetry = { timer: null, n: 0 };
}

function listFailed(error, latest, wanted, search) {
  const plan = listFailure({ error, latest, wanted, shown: shownScreen, search });
  if (!plan) return;
  if (plan.clear) {
    state.slug = null;
    state.tasks = [];
    renderBoard();
    return;
  }
  if (plan.back) putScreenBack(plan.back);
  if (!plan.notice) { loadProjects().catch(() => {}); return; } // the project is gone: the sidebar drops it
  const again = Boolean(pendingLoad) && sameScreen(pendingLoad.to, plan.retry);
  pendingLoad = { from: plan.back || wanted, to: plan.retry };
  const notice = listNotice(plan.notice, plan.answered);
  showLoadNotice(notice);
  if (plan.answered) retryLater(); else retryNoMore();
  if (plan.notice === 'first') {
    state.tasks = [];
    state.listNote = { text: notice.title, retry: () => retryLoad() };
    renderBoard();
  }
  // a click that went nowhere is said in words, once: the badge alone is easy to miss right after the click
  if (plan.notice === 'project' && !again) styledAlert(tr(plan.answered ? LIST_NOTICE.project.alertError : LIST_NOTICE.project.alert));
}

// The screen the failed switch was leaving comes back as it was — its board or section is still drawn, no request.
function putScreenBack(screen) {
  state.slug = screen.slug;
  state.projSettings = screen.settings ? screen.slug : null;
  rememberScreen(screen.slug);
  renderSidebar();
  renderTopbar();
  showView(viewOf(screen));
}

function showLoadNotice(n) {
  const el = $('load-badge');
  if (!el) return;
  el.classList.toggle('hidden', !n);
  if (!n) return;
  el.textContent = tr(n.label);
  el.title = tr(n.title);
  if (!el.onclick) el.onclick = () => retryLoad();
}

export function retryLoad() {
  const what = listRetry(pendingLoad, currentScreen());
  if (!what) { pendingLoad = null; showLoadNotice(null); retryNoMore(); return undefined; }
  if (what === 'switch') { selectProject(pendingLoad.to.slug, { settings: pendingLoad.to.settings }); return undefined; }
  return loadTasks();
}

export function resumeSwitch() {
  if (listRetry(pendingLoad, currentScreen()) !== 'switch') return;
  const to = pendingLoad.to;
  state.slug = to.slug;
  state.projSettings = to.settings ? to.slug : null;
  rememberScreen(to.slug);
  renderSidebar();
  renderTopbar();
}

const PIN_ICON = ic('pin', 12);
const NAV_IC = { [HORIZON]: 'trend', [CALENDAR]: 'timer' };
const navIc = (name) => (name ? `<span class="nav-ic">${ic(name, 15)}</span>` : '');

export function renderSidebar() {
  const box = $('projects');
  box.innerHTML = '';

  const newEl = document.createElement('div');
  newEl.className = 'proj-new' + (state.slug === CHAOS ? ' active' : '');
  newEl.innerHTML = `<span class="nav-ic nav-new">${ic('plus', 13)}</span><span class="proj-name">${tr('New task')}</span>`;
  newEl.onclick = () => selectProject(CHAOS).then(() => $('chaos-input')?.focus());
  box.appendChild(newEl);

  const dashEl = document.createElement('div');
  dashEl.className = 'proj proj-dash' + (state.slug === DASH ? ' active' : '');
  dashEl.innerHTML = `${navIc('chart')}<span class="proj-name">${tr('Dashboard')}</span>`;
  dashEl.dataset.slug = DASH;
  dashEl.onclick = () => selectProject(DASH);
  box.appendChild(dashEl);

  const inWork = state.projects.reduce((s, p) => s + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_deploy || 0), 0);
  const nowEl = document.createElement('div');
  nowEl.className = 'proj proj-now' + (state.slug === NOW ? ' active' : '');
  nowEl.innerHTML = `${navIc('bot')}<span class="proj-name">${tr('Claude now')}</span>
    <span class="card-live live-busy proj-live hidden" title="${esc(tr('Claude is working right now'))}"><span class="live-dot"></span></span>
    <span class="proj-counts">${inWork || ''}</span>`;
  nowEl.dataset.slug = NOW;
  nowEl.onclick = () => selectProject(NOW);
  box.appendChild(nowEl);
  markNowEntry();

  // them either — it said 7 over a section of 4 tasks
  const inReview = state.projects.reduce((s, p) => s + (p.c_review || 0) - (p.c_review_check || 0), 0);
  const reviewEl = document.createElement('div');
  reviewEl.className = 'proj proj-check' + (state.slug === REVIEW ? ' active' : '');
  reviewEl.innerHTML = `${navIc('eye')}<span class="proj-name">${tr('Claude review')}</span>
    ${inReview ? `<span class="proj-review" title="${inReview} ${esc(tr('tasks waiting for your check'))}"></span>` : ''}
    <span class="proj-counts">${inReview || ''}</span>`;
  reviewEl.dataset.slug = REVIEW;
  reviewEl.onclick = () => selectProject(REVIEW);
  box.appendChild(reviewEl);

  const doneEl = document.createElement('div');
  doneEl.className = 'proj proj-done' + (state.slug === DONE ? ' active' : '');
  doneEl.innerHTML = `${navIc('check')}<span class="proj-name">${tr('Claude done')}</span>`;
  doneEl.dataset.slug = DONE;
  doneEl.onclick = () => selectProject(DONE);
  box.appendChild(doneEl);

  const autoOn = automations().on;
  if (autoOn || state.slug === AUTO) {
    const armed = armedRules().length;
    const autoEl = document.createElement('div');
    autoEl.className = 'proj proj-auto' + (state.slug === AUTO ? ' active' : '');
    autoEl.innerHTML = `${navIc('bolt')}<span class="proj-name">${tr('Automations')}</span><span class="proj-counts">${armed || ''}</span>`;
    autoEl.dataset.slug = AUTO;
    autoEl.onclick = () => selectProject(AUTO);
    box.appendChild(autoEl);
  }

  if (getSetting('showHealth') || state.slug === HEALTH) {
    const healthEl = document.createElement('div');
    healthEl.className = 'proj proj-health' + (state.slug === HEALTH ? ' active' : '');
    healthEl.innerHTML = `${navIc('pulse')}<span class="proj-name">${tr('Health')}</span><span class="proj-counts"></span>`;
    healthEl.dataset.slug = HEALTH;
    healthEl.onclick = () => selectProject(HEALTH);
    box.appendChild(healthEl);
  }

  for (const [slug, name] of SIDEBAR_SECTIONS) {
    const el = document.createElement('div');
    el.className = 'proj proj-section' + (state.slug === slug ? ' active' : '');
    el.innerHTML = `${navIc(NAV_IC[slug])}<span class="proj-name">${name}</span>`;
    el.dataset.slug = slug;
    el.onclick = () => selectProject(slug);
    box.appendChild(el);
  }

  const totalActive = state.projects.reduce((s, p) => s + (p.c_todo || 0) + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_deploy || 0) + (p.c_review || 0), 0);
  const allEl = document.createElement('div');
  allEl.className = 'proj proj-all' + (state.slug === ALL ? ' active' : '');
  allEl.innerHTML = `${navIc('grid')}<span class="proj-name">${tr('All projects')}</span>
    <span class="proj-counts">${totalActive || ''}</span>`;
  allEl.dataset.slug = ALL;
  allEl.onclick = () => selectProject(ALL);
  box.appendChild(allEl);

  const setEl = document.createElement('div');
  setEl.className = 'proj proj-settings';
  setEl.innerHTML = `${navIc('gear')}<span class="proj-name"><span class="set-ic">${ic('gear', 13)} </span>${tr('Settings')}</span>`
    + `<button type="button" class="btn-icon proj-search" title="${esc(tr('Search projects and tasks'))}" aria-label="${esc(tr('Search projects and tasks'))}">${ic('search', 14)}</button>`
    + shareButtonHTML();
  setEl.onclick = () => { openSide(false); openSettingsModal(); };
  setEl.querySelector('.proj-search').onclick = (e) => { e.stopPropagation(); openSide(false); openSearch(); };
  setEl.querySelector('.proj-share').onclick = (e) => { e.stopPropagation(); openSide(false); openSettingsModal('share'); };
  box.appendChild(setEl);

  const missingSlugs = new Set((state.folders.missing || []).map((m) => m.slug));

  const pinnedList = state.projects.filter((p) => p.pinned);
  if (pinnedList.length) {
    const h = document.createElement('div');
    h.className = 'cat-head';
    h.innerHTML = catNameHTML(tr('Pinned'));
    box.appendChild(h);
    for (const p of pinnedList) {
      const el = makeProjEl(p, missingSlugs.has(p.slug));
      el.dataset.category = '__pinned__';
      box.appendChild(el);
    }
  }

  const byCat = new Map();
  for (const p of state.projects) {
    const cat = p.category || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(p);
  }

  for (const [cat, list] of byCat) {
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const h = document.createElement('div');
    h.className = 'cat-head';
    h.innerHTML = catNameHTML(tr(cat));
    if (cat === 'Local') {
      const add = document.createElement('button');
      add.className = 'btn-icon cat-add';
      add.textContent = '+';
      add.title = tr('Create a project folder');
      add.onclick = (e) => { e.stopPropagation(); createFolder(); };
      h.appendChild(add);
    }
    box.appendChild(h);
    for (const p of list) box.appendChild(makeProjEl(p, missingSlugs.has(p.slug)));
    // sidebar; unfolded, they stay so on this computer
    const ghosts = cat === 'Local' ? (state.folders.unregistered || []) : [];
    if (ghosts.length) {
      const open = ghostsOpen();
      const t = document.createElement('div');
      t.className = 'proj proj-ghost-toggle' + (open ? ' open' : '');
      t.title = tr(open ? 'Hide the folders that are not on the board' : 'Show the folders that are not on the board');
      t.innerHTML = `<span class="proj-name">${tr('Folders not on the board')}</span><span class="proj-counts">${ghosts.length}</span>`;
      t.onclick = () => { setGhostsOpen(!open); renderSidebar(); };
      box.appendChild(t);
    }
    if (ghosts.length && ghostsOpen()) {
      for (const folder of ghosts) {
        const el = document.createElement('div');
        el.className = 'proj proj-ghost';
        el.innerHTML = `<span class="proj-name" title="${tr('new folder')} ${esc(folder)} — ${tr('not on the board yet')}">${esc(folder)}</span>
          <span class="ghost-add" title="${tr('Add to the board')}">+ ${tr('add')}</span>`;
        el.querySelector('.ghost-add').onclick = (e) => { e.stopPropagation(); adoptFolder(folder); };
        box.appendChild(el);
      }
    }
  }

  const addProj = document.createElement('div');
  addProj.className = 'proj proj-add';
  addProj.innerHTML = `<span class="proj-name">${tr('＋ Add project')}</span>`;
  addProj.onclick = openProjectWizard;
  box.appendChild(addProj);
}

function ghostsOpen() { try { return localStore.getItem('kb.ui.ghostFolders') === '1'; } catch { return false; } }
function setGhostsOpen(open) { try { localStore.setItem('kb.ui.ghostFolders', open ? '1' : '0'); } catch { /* until reload */ } }

// board works past its tasks in work (state.liveProjects, from the server): "Claude now" showed them at work, the
// sidebar did not
function workingProjects() {
  const busy = Object.values(state.live || {}).filter((l) => ['busy', 'starting', 'background'].includes(l.claude) && l.project).map((l) => l.project);
  return new Set([...busy, ...(state.liveProjects || [])]);
}
export function markNowEntry() {
  const working = workingProjects();
  const busy = Object.values(state.live || {}).some((l) => l.claude === 'busy' || l.claude === 'background') || (state.liveProjects || []).length > 0;
  document.querySelector('#projects .proj-now .proj-live')?.classList.toggle('hidden', !busy);
  document.querySelectorAll('#projects .proj[data-slug]').forEach((el) => el.classList.toggle('ai-working', working.has(el.dataset.slug)));
}

// its name, as the owner asked; the project rows under it carry no icon. The letter is the first letter or digit of the
// name (an emoji or a sign in front is skipped), in capitals; a name without one gives its first sign.
export function nameInitial(name) {
  const s = String(name || '').trim();
  const m = s.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : [...s][0] || '?').toLocaleUpperCase();
}
function catNameHTML(name) {
  return `<span class="cat-label"><span class="cat-ic" aria-hidden="true">${esc(nameInitial(name))}</span>${esc(name)}</span>`;
}

function makeProjEl(p, missing) {
  const el = document.createElement('div');
  el.className = 'proj' + (p.slug === state.slug ? ' active' : '');
  const ntodo = p.c_todo || 0;
  const todoTip = esc(`${tr('To do')}: ${ntodo}`);
  el.innerHTML = `<span class="proj-name" title="${esc(p.slug)}">${esc(p.name || p.slug)}</span>
    ${missing ? `<span class="proj-missing" title="${esc(tr('folder is gone — click to archive'))}">${ic('warn', 12)}</span>` : ''}
    ${ntodo ? `<span class="proj-todo" title="${todoTip}"></span>` : ''}
    <span class="proj-work" title="${esc(tr('Claude is working in this project'))}"></span>
    <span class="proj-counts"${ntodo ? ` title="${todoTip}"` : ''}>${ntodo || ''}</span>
    <span class="proj-pin${p.pinned ? ' on' : ''}" title="${p.pinned ? tr('Unpin') : tr('Pin to the top')}">${PIN_ICON}</span>`;
  el.dataset.slug = p.slug;
  el.classList.toggle('ai-working', workingProjects().has(p.slug));
  el.dataset.category = p.category || 'Other';
  el.onclick = () => selectProject(p.slug);
  el.oncontextmenu = (e) => { e.preventDefault(); openProjectSettings(p); };
  if (missing) el.querySelector('.proj-missing').onclick = (e) => { e.stopPropagation(); archiveMissing(p.slug, p.name || p.slug); };
  el.querySelector('.proj-pin').onclick = (e) => { e.stopPropagation(); togglePin(p); };
  attachProjDnd(el);
  return el;
}

let dragProjSlug = null;
function attachProjDnd(el) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragProjSlug = el.dataset.slug;
    el.classList.add('proj-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.slug);
  });
  el.addEventListener('dragend', () => {
    dragProjSlug = null;
    document.querySelectorAll('.proj-dragging, .proj-drop-before, .proj-drop-after')
      .forEach((x) => x.classList.remove('proj-dragging', 'proj-drop-before', 'proj-drop-after'));
  });
  el.addEventListener('dragover', (e) => {
    if (!dragProjSlug || dragProjSlug === el.dataset.slug) return;
    const src = document.querySelector(`.proj[data-slug="${CSS.escape(dragProjSlug)}"]`);
    if (!src || src.dataset.category !== el.dataset.category) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = (e.clientY - el.getBoundingClientRect().top) > el.offsetHeight / 2;
    el.classList.toggle('proj-drop-after', after);
    el.classList.toggle('proj-drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('proj-drop-before', 'proj-drop-after'));
  el.addEventListener('drop', async (e) => {
    if (!dragProjSlug || dragProjSlug === el.dataset.slug) return;
    const src = document.querySelector(`.proj[data-slug="${CSS.escape(dragProjSlug)}"]`);
    if (!src || src.dataset.category !== el.dataset.category) return;
    e.preventDefault();
    const after = el.classList.contains('proj-drop-after');
    el.classList.remove('proj-drop-before', 'proj-drop-after');
    el.parentNode.insertBefore(src, after ? el.nextSibling : el);
    const slugs = [...document.querySelectorAll(`.proj[data-category="${CSS.escape(el.dataset.category)}"]`)]
      .map((x) => x.dataset.slug);
    await api('POST', '/api/projects/reorder', { slugs });
    await refresh();
  });
}

export const NARROW = '(max-width: 760px)';
export function openSide(on) {
  const root = document.documentElement;
  if (on === root.classList.contains('side-open')) return;
  root.classList.toggle('side-open', on);
  if (on) pushLayer('side', () => openSide(false)); else popLayer('side');
}
function wireSide() {
  const btn = $('side-open');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.innerHTML = ic('menu', 18);
  btn.title = tr('Projects and sections');
  btn.setAttribute('aria-label', tr('Projects and sections'));
  btn.onclick = () => openSide(true);
  $('side-scrim').onclick = () => openSide(false);
  globalThis.matchMedia?.(NARROW).addEventListener?.('change', (e) => { if (!e.matches) openSide(false); });
}
wireSide();

export function selectProject(slug, { settings = false, asked = false } = {}) {
  openSide(false);
  if (!asked && state.leaveGuard && state.projSettings && !(settings && slug === state.projSettings)) {
    const go = state.leaveGuard();
    if (go !== true) return Promise.resolve(go).then((ok) => (ok ? selectProject(slug, { settings, asked: true }) : undefined));
  }
  state.slug = slug;
  state.projSettings = settings ? slug : null;
  rememberScreen(slug);
  renderSidebar(); renderTopbar();
  return loadTasks();
}
function rememberScreen(slug) {
  localStore.setItem('kb.ui.project', slug);
  sessionStore.setItem('kb.session.slug', slug);
}

export function switchProject(dir) {
  const slugs = [...new Set([...document.querySelectorAll('#projects .proj[data-slug]')].map((el) => el.dataset.slug))];
  if (!slugs.length) return;
  let i = slugs.indexOf(state.slug);
  i = i < 0 ? 0 : Math.max(0, Math.min(slugs.length - 1, i + dir));
  if (slugs[i] !== state.slug) selectProject(slugs[i]);
}

async function togglePin(p) {
  await api('PATCH', `/api/projects/${seg(p.slug)}`, { pinned: p.pinned ? 0 : 1 });
  await refresh();
}

const openLayers = [];
let layerWatch = null;
export function watchLayers(fn) { layerWatch = fn; }
export const layersOpen = () => openLayers.length > 0;
export function pushLayer(key, close) {
  const i = openLayers.findIndex((l) => l.key === key);
  if (i >= 0) openLayers.splice(i, 1);
  openLayers.push({ key, close });
  layerWatch?.(openLayers.length);
}
export function popLayer(key) {
  const i = openLayers.findIndex((l) => l.key === key);
  if (i < 0) return;
  openLayers.splice(i, 1);
  layerWatch?.(openLayers.length);
}
export function closeTopLayer() {
  const top = openLayers.pop();
  if (!top) return false;
  layerWatch?.(openLayers.length);
  top.close();
  return true;
}
export function overlayLayer(overlay, { onClose, backdrop = true, confirmClose } = {}) {
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    popLayer(overlay);
    overlay.remove();
    onClose?.();
  };
  let asking = false;
  const requestClose = async () => {
    if (asking || !overlay.isConnected) return;
    if (confirmClose) {
      asking = true;
      let ok = false;
      try { ok = await confirmClose(); } finally { asking = false; }
      if (!ok) { if (overlay.isConnected) pushLayer(overlay, requestClose); return; }
    }
    close();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || openLayers[openLayers.length - 1]?.key !== overlay) return;
    e.stopImmediatePropagation();
    requestClose();
  };
  document.addEventListener('keydown', onKey, true);
  if (backdrop) overlay.addEventListener('click', (e) => { if (e.target === overlay) requestClose(); });
  pushLayer(overlay, requestClose);
  return confirmClose ? requestClose : close;
}

export function styledPrompt(title, { placeholder = '', okLabel = 'OK', onSubmit } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${esc(typeset(title))}</div>
      <input class="modal-input" type="text" placeholder="${esc(placeholder)}">
      <div class="modal-err hidden"></div>
      <div class="modal-actions">
        <button class="btn-primary modal-ok">${esc(okLabel)}</button>
        <button class="btn-ghost modal-cancel">${tr('Cancel')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.modal-input');
  const errEl = overlay.querySelector('.modal-err');
  const okBtn = overlay.querySelector('.modal-ok');
  const close = overlayLayer(overlay);
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    okBtn.disabled = true;
    try { await onSubmit(v); close(); }
    catch (e) { errEl.textContent = errorLine('Did not work out', e, tr); errEl.classList.remove('hidden'); okBtn.disabled = false; }
  };
  okBtn.onclick = submit;
  overlay.querySelector('.modal-cancel').onclick = close;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
}

const DANGER_ENTER_MS = 600;
// `detail` — text shown as it is under the question, in a box of its own: exactly what an action is going to write,
// one entry per line
export function styledConfirm(message, { okLabel = 'OK', danger = false, noCancel = false, detail = '', alt = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal${detail ? ' modal-wide' : ''}">
        <div class="modal-title">${esc(typeset(message))}</div>
        ${detail ? `<pre class="modal-detail">${esc(detail)}</pre>` : ''}
        <div class="modal-actions">
          <button class="btn-primary modal-ok${danger ? ' danger' : ''}">${esc(okLabel)}</button>
          ${alt ? `<button class="btn-ghost modal-alt">${esc(alt)}</button>` : ''}
          ${noCancel ? '' : `<button class="btn-ghost modal-cancel">${tr('Cancel')}</button>`}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const opened = Date.now();
    const done = (v) => { popLayer(overlay); overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    pushLayer(overlay, () => done(false));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); done(false); }
      else if (e.key === 'Enter') {
        e.stopImmediatePropagation();
        if (danger && (e.repeat || Date.now() - opened < DANGER_ENTER_MS)) return;
        done(true);
      }
    };
    overlay.querySelector('.modal-ok').onclick = () => done(true);
    overlay.querySelector('.modal-cancel')?.addEventListener('click', () => done(false));
    overlay.querySelector('.modal-alt')?.addEventListener('click', () => done('alt'));
    // used to cancel at once (the window flashed and was gone); a click on the backdrop that soon is not the person's
    overlay.onclick = (e) => { if (e.target === overlay && e.detail < 2 && Date.now() - opened > 500) done(false); };
    document.addEventListener('keydown', onKey, true);
  });
}

export const styledAlert = (message) => styledConfirm(message, { okLabel: tr('Got it'), noCancel: true });
export const confirmDiscard = () => styledConfirm(tr('Discard the changes that are not saved?'), { okLabel: tr('Discard'), danger: true });

function createFolder() {
  styledPrompt(tr('New project folder'), {
    placeholder: tr('name (created in ~/claude-projects)'),
    okLabel: tr('Create'),
    onSubmit: async (name) => { await api('POST', '/api/projects/folders', { name }); await refresh(); },
  });
}
async function adoptFolder(name) {
  try { await api('POST', '/api/projects/folders', { name }); }
  catch (e) { styledAlert(refusalLine('Could not add the folder', e, tr)); return; }
  await refresh();
}
async function archiveMissing(slug, name) {
  if (!await styledConfirm(`${tr('The project folder')} "${name}" ${tr('is gone from disk. Archive the project? Tasks are kept.')}`, { okLabel: tr('Archive') })) return;
  await api('PATCH', `/api/projects/${seg(slug)}`, { archived: 1 });
  if (state.slug === slug) state.slug = null;
  await refresh();
}

export function currentProject() { return state.projects.find((x) => x.slug === state.slug); }

const WIZ_TYPES = [
  ['local', tr('Local project'), tr('a folder on this computer — or just a task board without one')],
  ['localserver', tr('Local + server'), tr('local copy of the code + deploy to a server over ssh')],
  ['server', tr('Server only'), tr('no local copy — Claude works over ssh; git required on the server')],
];

function wizSlugify(name) {
  const ru = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return name.toLowerCase().split('').map((c) => ru[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function setState(id, text, kind) {
  const el = $(id);
  if (!el) return;
  if (el._idle === undefined) el._idle = el.innerHTML;
  if (text) el.textContent = text; else el.innerHTML = el._idle;
  el.classList.remove('ok', 'bad');
  if (text && kind) el.classList.add(kind);
}

function wizPrefix(slug, used = new Set(state.projects.map((p) => p.prefix).filter(Boolean))) {
  const words = slug.replace(/[^a-z0-9-]/gi, '').split('-').filter(Boolean);
  let base = words.length >= 2
    ? words.map((w) => w[0]).join('').slice(0, 3).toUpperCase()
    : (words[0] || '').slice(0, 3).toUpperCase();
  if (base.length < 2) base = (base + 'XX').slice(0, 2);
  let prefix = base;
  let n = 2;
  while (used.has(prefix)) prefix = base + n++;
  return prefix;
}

export async function checkPath(path) {
  if (!path) { setState('wiz-path-state', tr('give the folder path'), 'bad'); return false; }
  setState('wiz-path-state', tr('checking…'));
  try {
    const r = await api('GET', `/api/fs?path=${encodeURIComponent(path)}`, null, { quiet: true });
    setState('wiz-path-state', `${tr('the folder is there')} · ${r.dirs.length} ${plural(r.dirs.length, 'subfolder', 'subfolders')}`, 'ok');
    return true;
  } catch (e) {
    const said = { 404: tr('no such folder on this computer'),
      400: tr('this path is not a folder'),
      403: tr('the folder is there, but the board cannot read it — check its permissions') }[e.status];
    setState('wiz-path-state', said || refusalLine('could not check the folder', e, tr), 'bad');
    return false;
  }
}

const SSH_WHY = {
  unknown_host: 'no such host — check the name, or add it to your ~/.ssh/config',
  key_refused: 'the server refused the key — a password will not help here, the key has to be authorized',
  host_key: 'the host key is unknown — connect once from your terminal and confirm the fingerprint',
  unreachable: 'the server did not answer — wrong address, wrong port, or it is down',
  failed: 'could not connect',
};
export async function checkSsh() {
  const server = $('wiz-server')?.value.trim();
  const path = $('wiz-spath')?.value.trim();
  if (!server) { setState('wiz-ssh-state', tr('give the ssh host'), 'bad'); return; }
  const btn = $('wiz-ssh-check');
  if (btn) btn.disabled = true;
  setState('wiz-ssh-state', tr('connecting…'));
  try {
    const r = await api('POST', '/api/projects/ssh-check', { server, path }, { quiet: true });
    const dir = r.path_exists === null ? '' : ` · ${r.path_exists ? tr('the server path is there') : tr('but there is no such path on the server')}`;
    setState('wiz-ssh-state', `${tr('connected')}${dir}`, r.path_exists === false ? 'bad' : 'ok');
  } catch (e) {
    setState('wiz-ssh-state', tr(SSH_WHY[e.body?.reason] || SSH_WHY.failed), 'bad');
  }
  if (btn) btn.disabled = false;
}

export async function openFolderPicker() {
  const box = $('wiz-browser'); const input = $('wiz-path');
  if (!box || !input) return;
  try {
    const r = await api('POST', '/api/fs/pick', null, { quiet: true });
    if (r?.path) { input.value = r.path; box.classList.add('hidden'); return; }
    if (r?.cancelled) return;
  } catch {  }
  await renderFolderBrowser(input.value.trim() || undefined);
}

export async function renderFolderBrowser(path) {
  const box = $('wiz-browser');
  if (!box) return;
  let d;
  const ask = (p) => api('GET', p ? `/api/fs?path=${encodeURIComponent(p)}` : '/api/fs', null, { quiet: true });
  try { d = await ask(path); } catch { try { d = await ask(); } catch { return; } }
  const child = (n) => (d.path.endsWith('/') ? d.path + n : `${d.path}/${n}`);
  box.classList.remove('hidden');
  box.innerHTML = `<div class="wizb-path">${esc(d.path)}</div>`
    + '<div class="wizb-list">'
    + (d.parent ? `<div class="wizb-row wizb-up" data-p="${esc(d.parent)}">..</div>` : '')
    + d.dirs.map((n) => `<div class="wizb-row" data-p="${esc(child(n))}">${esc(n)}</div>`).join('')
    + (d.dirs.length ? '' : `<div class="wizb-note">${tr('no folders inside')}</div>`)
    + (d.truncated ? `<div class="wizb-note">${tr('too many folders to show them all')}</div>` : '')
    + '</div>'
    + `<button type="button" class="btn-primary wizb-pick">${tr('Use this folder')}</button>`;
  box.querySelectorAll('.wizb-row').forEach((r) => { r.onclick = () => renderFolderBrowser(r.dataset.p); });
  box.querySelector('.wizb-pick').onclick = () => { $('wiz-path').value = d.path; box.classList.add('hidden'); };
}

function openProjectWizard() {
  document.getElementById('proj-wizard')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'proj-wizard';
  overlay.innerHTML = `
    <div class="modal wiz">
      <div class="modal-title">${tr('Add project')}</div>
      <div class="wiz-body"></div>
      <div class="modal-err hidden"></div>
      <div class="modal-actions wiz-actions"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.wiz-body');
  const actions = overlay.querySelector('.wiz-actions');
  const errEl = overlay.querySelector('.modal-err');
  let created = false;
  const filled = () => [...body.querySelectorAll('input[type="text"]')].some((i) => i.value.trim() && i.value !== i.defaultValue);
  const close = overlayLayer(overlay, { confirmClose: () => created || !filled() || confirmDiscard() });
  const err = (msg) => { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); };

  const stepType = () => {
    err('');
    body.innerHTML = WIZ_TYPES.map(([id, title, sub]) =>
      `<button type="button" class="wiz-type" data-type="${id}"><b>${esc(title)}</b><small>${esc(sub)}</small></button>`).join('')
      + `<div class="wiz-h">${tr('or let Claude do it')}</div>`
      + `<div class="kbh-note muted">${tr('Claude looks at the folder itself, checks the server access, and asks you one question at a time. Paste this into your Claude Code chat.')}</div>`
      + `<div class="setup-prompt"><pre class="onb-code setup-prompt-text">${esc(addProjectPrompt())}</pre>`
      + `<button type="button" class="btn-ghost wiz-ai-copy">${ic('copy', 13)} ${tr('Copy the prompt')}</button></div>`;
    actions.innerHTML = `<button class="btn-ghost wiz-cancel">${tr('Cancel')}</button>`;
    actions.querySelector('.wiz-cancel').onclick = close;
    body.querySelectorAll('.wiz-type').forEach((b) => { b.onclick = () => stepForm(b.dataset.type); });
    const aiBtn = body.querySelector('.wiz-ai-copy');
    aiBtn.onclick = async () => {
      const okCopy = await copyText(addProjectPrompt());
      const was = aiBtn.innerHTML;
      aiBtn.innerHTML = okCopy ? `✓ ${tr('Copied')}` : `✕ ${tr('did not work — select and copy manually')}`;
      setTimeout(() => { aiBtn.innerHTML = was; }, 2000);
    };
  };

  const stepForm = (type) => {
    err('');
    const withServer = type !== 'local';
    const withLocal = type !== 'server';
    const folders = state.folders.unregistered || [];
    let html = `<label class="pp-field">${tr('Project name')}<input id="wiz-name" type="text" placeholder="my project"></label>`
      + `<label class="pp-field">${tr('Key (slug + task prefix)')}<input id="wiz-slug" type="text" placeholder="my-project">`
      + `<small class="pp-hint" id="wiz-slug-state"></small></label>`;
    if (withLocal) {
      html += `<div class="pp-field">${tr('Project folder')}
        <div id="wiz-folder"></div>
        <div id="wiz-path-row" class="wiz-path-row hidden">
          <input id="wiz-path" type="text" placeholder="/full/path/to/the/folder">
          <button type="button" class="btn-ghost" id="wiz-browse">${tr('Choose…')}</button>
          <button type="button" class="btn-ghost" id="wiz-path-check">${tr('Check')}</button>
        </div>
        <small class="pp-hint" id="wiz-path-state"></small>
        <div id="wiz-browser" class="wiz-browser hidden"></div>
        <input id="wiz-git" type="text" class="hidden" placeholder="git@github.com:me/repo.git">
        <small class="pp-hint hidden" id="wiz-git-hint"></small></div>`;
    }
    if (withServer) {
      html += `<div class="wiz-h">${tr('Server')}</div>`
        + `<div class="kbh-note muted">${tr('Not about this computer. Empty means the project simply stays local.')}</div>`
        + `<div class="pp-field">${tr('SSH host')}`
        + `<div class="wiz-path-row"><input id="wiz-server" type="text" placeholder="192.168.1.10">`
        + `<button type="button" class="btn-ghost" id="wiz-ssh-check">${tr('Check')}</button></div>`
        + `<small class="pp-hint" id="wiz-ssh-state">${tr('no key or password is entered here: access comes from your ~/.ssh/config, and a password will not do — a key is required. If ssh &lt;host&gt; works in your terminal, it works here.')}</small></div>`
        + `<label class="pp-field">${tr('Server path')}<input id="wiz-spath" type="text" placeholder="/var/www/my-project"></label>`
        + `<label class="pp-field">${tr('pm2 processes (comma-separated)')}<input id="wiz-pm2" type="text" placeholder="my-api, my-web"></label>`
        + `<label class="pp-field">${tr('Domain (to verify after deploy)')}<input id="wiz-domain" type="text" placeholder="example.com"></label>`
        + `<div class="pp-field">${tr('Deploy skill')}<div id="wiz-skill"></div>`
        + `<small class="pp-hint">${tr('your own deploy skill is created and edited in Settings → Skills')}</small></div>`;
    }
    body.innerHTML = html;
    actions.innerHTML = `<button class="btn-primary wiz-create">${tr('Create')}</button><button class="btn-ghost wiz-back">${tr('‹ Back')}</button>`;
    actions.querySelector('.wiz-back').onclick = stepType;
    const nameEl = $('wiz-name');
    const slugEl = $('wiz-slug');
    let slugTouched = false;
    const showSlugState = () => {
      const el = $('wiz-slug-state');
      if (!el) return;
      const v = slugEl.value.trim();
      const taken = v && state.projects.find((p) => p.slug === v);
      el.classList.remove('ok', 'bad');
      if (!v) { el.textContent = ''; return; }
      if (!/^[a-z0-9-]{2,40}$/.test(v)) { el.textContent = tr('key: lowercase latin letters, digits and hyphens'); el.classList.add('bad'); return; }
      el.textContent = taken ? `${tr('this key is already taken by')} ${taken.name || taken.slug}` : `${tr('key is free')} · ${tr('task prefix')} ${wizPrefix(v)}`;
      el.classList.add(taken ? 'bad' : 'ok');
    };
    slugEl.oninput = () => { slugTouched = true; showSlugState(); };
    nameEl.oninput = () => { if (!slugTouched) slugEl.value = wizSlugify(nameEl.value); showSlugState(); };
    const folderSel = $('wiz-folder');
    if (folderSel) {
      const options = [
        ...(type === 'local' ? [{ value: '', label: tr('no folder — just a task list') }] : []),
        { value: '__manual__', label: tr('a folder on this computer') },
        ...(type === 'localserver' ? [{ value: '__clone__', label: tr('clone from a git URL…') }] : []),
      ];
      const onFolderChange = (v) => {
        $('wiz-path-row').classList.toggle('hidden', v !== '__manual__');
        $('wiz-path-state').classList.toggle('hidden', v !== '__manual__');
        $('wiz-browser').classList.add('hidden');
        $('wiz-git').classList.toggle('hidden', v !== '__clone__');
        const gh = $('wiz-git-hint');
        gh.classList.toggle('hidden', v !== '__clone__');
        if (v === '__clone__') {
          const root = state.folders.root || '~';
          const key = $('wiz-slug').value.trim() || 'my-project';
          gh.textContent = `${tr('on create, git clone puts it on THIS computer at')} ${root}/${key}. `
            + tr('An existing folder is refused, not overwritten. Git credentials are not asked here — access comes from your own git and ssh setup.');
        }
      };
      const start = type === 'local' ? '' : '__manual__';
      buildSelect(folderSel, { value: start, options, onChange: onFolderChange });
      onFolderChange(start);
      $('wiz-browse').onclick = openFolderPicker;
      $('wiz-path-check').onclick = () => checkPath($('wiz-path').value.trim());
      $('wiz-path').oninput = () => setState('wiz-path-state', '');
    }
    if ($('wiz-ssh-check')) {
      $('wiz-ssh-check').onclick = checkSsh;
      $('wiz-server').oninput = () => setState('wiz-ssh-state', '');
      $('wiz-spath').oninput = () => setState('wiz-ssh-state', '');
    }
    const skillHost = $('wiz-skill');
    if (skillHost) {
      buildSelect(skillHost, { value: GENERIC_DEPLOY, options: skillOptions(GENERIC_DEPLOY, null) });
      api('GET', '/api/skills', null, { quiet: true })
        .then((info) => {
          if (!$('wiz-skill')) return;
          const generic = info.generic_deploy_skill || GENERIC_DEPLOY;
          const deployish = deploySkills(info);
          const has = deployish.some((s) => s.name === generic);
          buildSelect($('wiz-skill'), { value: has ? generic : '', options: skillOptions(generic, deployish) });
        })
        .catch(() => {  });
    }
    actions.querySelector('.wiz-create').onclick = () => wizCreate(type).catch((e) => err(errorLine('The project is not created', e, tr)));
    nameEl.focus();
  };

  const wizCreate = async (type) => {
    err('');
    const btn = actions.querySelector('.wiz-create');
    const name = $('wiz-name').value.trim();
    const slug = ($('wiz-slug').value.trim() || wizSlugify(name));
    if (!name) throw new Error(tr('the project needs a name'));
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error(tr('key: lowercase latin letters, digits and hyphens'));
    const body = { slug, name };
    const withServer = type !== 'server' ? type === 'localserver' : true;
    btn.disabled = true;
    try {
      if (type !== 'server') {
        const mode = $('wiz-folder') ? selVal($('wiz-folder')) : '';
        if (mode === '__manual__') {
          const p = $('wiz-path').value.trim();
          if (!p) throw new Error(tr('give the folder path'));
          try { await api('GET', `/api/fs?path=${encodeURIComponent(p)}`, null, { quiet: true }); }
          catch { throw new Error(`${tr('no such folder on this computer')}: ${p}`); }
          body.path = p;
        } else if (mode === '__clone__') {
          const url = $('wiz-git').value.trim();
          if (!url) throw new Error(tr('give the git URL'));
          btn.textContent = tr('cloning…');
          const r = await api('POST', '/api/projects/clone', { url, name: slug });
          body.path = r.path;
        }
        if (type === 'local') body.category = 'Local';
      }
      if (withServer) {
        const server = $('wiz-server').value.trim();
        const spath = $('wiz-spath').value.trim();
        if (type === 'server' && (!server || !spath)) throw new Error(tr('a server project needs an SSH host and a path'));
        if (server) body.server = server;
        if (spath) body.server_path = spath;
        const pm2 = $('wiz-pm2').value.split(',').map((s) => s.trim()).filter(Boolean);
        if (pm2.length) body.pm2_services = JSON.stringify(pm2);
        const domain = $('wiz-domain').value.trim();
        if (domain) body.domain = domain;
        const skill = selVal($('wiz-skill'));
        if (skill) body.deploy_skill = skill;
      }
      if (type === 'server') {
        btn.textContent = tr('checking git on the server…');
        const chk = await api('POST', '/api/projects/server-git', { server: body.server, path: body.server_path });
        if (!chk.git) {
          btn.textContent = tr('Create');
          const ok = await styledConfirm(`${tr('No git repository on the server at')} ${body.server_path}. ${tr('Run git init? Without git a server project cannot be created.')}`, { okLabel: 'git init' });
          if (!ok) throw new Error(tr('no git on the server — the project was not created'));
          btn.disabled = true; btn.textContent = 'git init…';
          await api('POST', '/api/projects/server-git', { server: body.server, path: body.server_path, init: true });
        }
      }
      btn.textContent = tr('creating…');
      await api('POST', '/api/projects', body);
      created = true;
      close();
      await refresh();
      selectProject(slug);
    } finally { btn.disabled = false; btn.textContent = tr('Create'); }
  };

  stepType();
}

// project, "quick task capture") is gone: the owner asked for no description there.
// not a 15px glyph sitting low on the baseline of an 18px heading
const TITLE_IC = 20;
export function renderTopbar() {
  if ($('project-title').isContentEditable) return;
  $('project-menu').classList.toggle('hidden', [DASH, NOW, REVIEW, DONE, AUTO, HEALTH, SETTINGS, HORIZON, CALENDAR, CHAOS, ALL].includes(state.slug));
  $('project-menu').classList.toggle('on', Boolean(state.projSettings));
  if (state.slug === DASH) {
    $('project-title').innerHTML = `${ic('chart', TITLE_IC)} ${esc(tr('Dashboard'))}`;
    return;
  }
  if (state.slug === NOW) {
    $('project-title').innerHTML = `${ic('bot', TITLE_IC)} ${esc(tr('Claude now'))}`;
    return;
  }
  if (state.slug === REVIEW) {
    $('project-title').innerHTML = `${ic('eye', TITLE_IC)} ${esc(tr('Claude review'))}`;
    return;
  }
  if (state.slug === DONE) {
    $('project-title').innerHTML = `${ic('check', TITLE_IC)} ${esc(tr('Claude done'))}`;
    return;
  }
  if (state.slug === AUTO) {
    $('project-title').innerHTML = `${ic('bolt', TITLE_IC)} ${esc(tr('Automations'))}`;
    return;
  }
  if (state.slug === HEALTH) {
    $('project-title').innerHTML = `${ic('pulse', TITLE_IC)} ${esc(tr('Health'))}`;
    return;
  }
  if (state.slug === HORIZON) { $('project-title').textContent = tr('Horizon'); return; }
  if (state.slug === CALENDAR) { $('project-title').textContent = tr('Calendar'); return; }
  if (state.slug === CHAOS) { $('project-title').textContent = tr('New task'); return; }
  if (state.slug === SETTINGS) {
    $('project-title').innerHTML = `${ic('gear', TITLE_IC)} ${esc(tr('Settings'))}`;
    return;
  }
  if (state.slug === ALL) {
    $('project-title').textContent = tr('All projects');
    return;
  }
  const p = currentProject();
  $('project-title').textContent = p ? (p.name || p.slug) : '—';
  $('project-title').title = p ? tr('Double-click to rename') : '';
}

function renameInTitle() {
  const h = $('project-title');
  const p = currentProject();
  if (!p || h.isContentEditable) return;
  const was = p.name || p.slug;
  try { h.contentEditable = 'plaintext-only'; } catch { /* an engine without it */ }
  if (h.contentEditable !== 'plaintext-only') h.contentEditable = 'true';
  h.classList.add('renaming');
  h.textContent = was;
  h.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(h);
  sel.addRange(range);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = h.textContent.replace(/\s+/g, ' ').trim();
    h.contentEditable = 'false';
    h.removeAttribute('contenteditable');
    h.classList.remove('renaming');
    h.onkeydown = null;
    h.onblur = null;
    if (!save || !name || name === was) { renderTopbar(); return; }
    h.textContent = name;
    try {
      await api('PATCH', `/api/projects/${seg(p.slug)}`, { name });
      p.name = name;
      loadProjects(); // the sidebar and the other lists show the new name
    } catch (e) {
      h.textContent = was;
      styledAlert(refusalLine('Could not rename the project', e, tr));
    }
    renderTopbar();
  };
  h.onkeydown = (e) => {
    // the board's keys are not for the title: Esc would close a card, Enter would add a line
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  h.onblur = () => finish(true);
}
$('project-title').ondblclick = renameInTitle;

export function setupPromptBlockHTML() {
  return `<div class="setup-prompt"><pre class="onb-code setup-prompt-text">${esc(setupPrompt())}</pre>`
    + `<button class="btn-primary setup-prompt-copy">${ic('copy', 13)} ${tr('Copy the prompt')}</button></div>`;
}
export function manualSetupHTML(packaged) {
  if (packaged) {
    return `<div class="muted onb-manual-h">${tr('Or do it by hand. Everything is already installed with the package:')}</div>`
      + `<div class="muted">${tr('the kb command came with it, and the wizard copied the Claude Code skills into ~/.claude/skills. To update later:')}</div>`
      + '<pre class="onb-code">npm i -g local-kanban@latest</pre>'
      + `<div class="muted">${tr('Details are in the README. Enjoy!')}</div>`;
  }
  return `<div class="muted onb-manual-h">${tr('Or do it by hand. Install the kb command for Claude like this:')}</div>
      <pre class="onb-code">npm link</pre>
      <div class="muted">${tr('Claude Code skills live in skills/ — symlink or copy them into ~/.claude/skills:')}</div>
      <pre class="onb-code">ln -s "$(pwd)/skills/kanban" ~/.claude/skills/kanban
ln -s "$(pwd)/skills/deploy" ~/.claude/skills/deploy</pre>
      <div class="muted">${tr('Details are in the README. Enjoy!')}</div>`;
}
export function wireSetupPrompt(root) {
  const btn = root.querySelector('.setup-prompt-copy');
  if (!btn) return;
  btn.onclick = async () => {
    const okCopy = await copyText(setupPrompt());
    const was = btn.innerHTML;
    btn.innerHTML = okCopy ? `✓ ${tr('Copied')}` : `✕ ${tr('did not work — select and copy manually')}`;
    setTimeout(() => { btn.innerHTML = was; }, 1800);
  };
}
