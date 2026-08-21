
import { buildSelect, renderBoard, selVal } from './board.js';

const GENERIC_DEPLOY = 'deploy';
import { renderChaos } from './chaos.js';
import { $, ALL, CALENDAR, CHAOS, DASH, HIDDEN_SECTIONS, HORIZON, LANG, SETTINGS, SIDEBAR_SECTIONS, api, esc, ic, seg, setupPrompt, state, tr } from './core.js';
import { renderDashboard } from './dash.js';
import { renderCalendar, renderHorizon } from './horizon.js';
import { openProjectSettings, renderProjectSettings, skillOptions } from './project.js';
import { openSettingsModal, plural, setSetting, syncLangToServer } from './settings.js';
import { copyText, refresh, showView } from './sse.js';

export async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  try { state.folders = await api('GET', '/api/projects/folders'); } catch {  }
  try { state.categories = await api('GET', '/api/categories'); } catch {  }
  const openable = [ALL, DASH, SETTINGS, HORIZON, CALENDAR, CHAOS].filter((s) => !HIDDEN_SECTIONS.includes(s));
  if (!state.slug || (!openable.includes(state.slug) && !state.projects.find((p) => p.slug === state.slug))) {
    state.slug = state.projects[0]?.slug || DASH;
  }
  renderSidebar();
  renderTopbar();
}

export async function loadTasks() {
  if (state.slug === SETTINGS) state.slug = DASH;
  if (state.slug === DASH) { showView('dashboard'); await renderDashboard(); return; }
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
  try {
    const q = state.search ? `&q=${encodeURIComponent(state.search)}` : '';
    state.tasks = state.slug === ALL
      ? await api('GET', `/api/tasks?all=1${q}`)
      : await api('GET', `/api/tasks?project=${encodeURIComponent(state.slug)}&all=1${q}`);
    state.searchApplied = state.search;
  } catch {
    state.slug = null;
    state.tasks = [];
    renderBoard();
    return;
  }
  renderBoard();
}

const PIN_ICON = ic('pin', 12);

export function renderSidebar() {
  const box = $('projects');
  box.innerHTML = '';

  const dashEl = document.createElement('div');
  dashEl.className = 'proj proj-dash' + (state.slug === DASH ? ' active' : '');
  dashEl.innerHTML = `<span class="proj-name">${tr('Dashboard')}</span>`;
  dashEl.dataset.slug = DASH;
  dashEl.onclick = () => selectProject(DASH);
  box.appendChild(dashEl);

  for (const [slug, name] of SIDEBAR_SECTIONS) {
    const el = document.createElement('div');
    el.className = 'proj proj-section' + (state.slug === slug ? ' active' : '');
    el.innerHTML = `<span class="proj-name">${name}</span>`;
    el.dataset.slug = slug;
    el.onclick = () => selectProject(slug);
    box.appendChild(el);
  }

  const totalActive = state.projects.reduce((s, p) => s + (p.c_todo || 0) + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_deploy || 0) + (p.c_review || 0), 0);
  const allEl = document.createElement('div');
  allEl.className = 'proj proj-all' + (state.slug === ALL ? ' active' : '');
  allEl.innerHTML = `<span class="proj-name">${tr('All projects')}</span>
    <span class="proj-counts">${totalActive || ''}</span>`;
  allEl.dataset.slug = ALL;
  allEl.onclick = () => selectProject(ALL);
  box.appendChild(allEl);

  const setEl = document.createElement('div');
  setEl.className = 'proj proj-settings';
  setEl.innerHTML = `<span class="proj-name">${ic('gear', 13)} ${tr('Settings')}</span>`;
  setEl.onclick = openSettingsModal;
  box.appendChild(setEl);

  const missingSlugs = new Set((state.folders.missing || []).map((m) => m.slug));

  const pinnedList = state.projects.filter((p) => p.pinned);
  if (pinnedList.length) {
    const h = document.createElement('div');
    h.className = 'cat-head';
    h.innerHTML = `<span>${tr('Pinned')}</span>`;
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
    h.innerHTML = `<span>${esc(tr(cat))}</span>`;
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
    if (cat === 'Local') {
      for (const folder of (state.folders.unregistered || [])) {
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

function makeProjEl(p, missing) {
  const el = document.createElement('div');
  el.className = 'proj' + (p.slug === state.slug ? ' active' : '');
  const active = (p.c_todo || 0) + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_deploy || 0) + (p.c_review || 0);
  const nrev = p.c_review || 0;
  el.innerHTML = `<span class="proj-name" title="${esc(p.slug)}">${esc(p.name || p.slug)}</span>
    ${missing ? `<span class="proj-missing" title="${esc(tr('folder is gone — click to archive'))}">${ic('warn', 12)}</span>` : ''}
    ${nrev ? `<span class="proj-review" title="${nrev} ${esc(tr('in review — waiting for you'))}"></span>` : ''}
    <span class="proj-counts">${active || ''}</span>
    <span class="proj-pin${p.pinned ? ' on' : ''}" title="${p.pinned ? tr('Unpin') : tr('Pin to the top')}">${PIN_ICON}</span>`;
  el.dataset.slug = p.slug;
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

export function selectProject(slug, { settings = false } = {}) {
  state.slug = slug;
  state.projSettings = settings ? slug : null;
  localStorage.setItem('kb.ui.project', slug);
  sessionStorage.setItem('kb.session.slug', slug);
  if (slug && slug !== ALL && !slug.startsWith('#')) localStorage.setItem('kb.ui.lastProject', slug);
  renderSidebar(); renderTopbar(); loadTasks();
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
export function pushLayer(key, close) {
  popLayer(key);
  openLayers.push({ key, close });
}
export function popLayer(key) {
  const i = openLayers.findIndex((l) => l.key === key);
  if (i >= 0) openLayers.splice(i, 1);
}
export function closeTopLayer() {
  const top = openLayers.pop();
  if (!top) return false;
  top.close();
  return true;
}
export function overlayLayer(overlay, { onClose, backdrop = true } = {}) {
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    popLayer(overlay);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  if (backdrop) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  pushLayer(overlay, close);
  return close;
}

export function styledPrompt(title, { placeholder = '', okLabel = 'OK', onSubmit } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${esc(title)}</div>
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
    catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); okBtn.disabled = false; }
  };
  okBtn.onclick = submit;
  overlay.querySelector('.modal-cancel').onclick = close;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
}

export function styledConfirm(message, { okLabel = 'OK', danger = false, noCancel = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${esc(message)}</div>
        <div class="modal-actions">
          <button class="btn-primary modal-ok${danger ? ' danger' : ''}">${esc(okLabel)}</button>
          ${noCancel ? '' : `<button class="btn-ghost modal-cancel">${tr('Cancel')}</button>`}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { popLayer(overlay); overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    pushLayer(overlay, () => done(false));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); done(false); }
      else if (e.key === 'Enter') { e.stopImmediatePropagation(); done(true); }
    };
    overlay.querySelector('.modal-ok').onclick = () => done(true);
    overlay.querySelector('.modal-cancel')?.addEventListener('click', () => done(false));
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
    document.addEventListener('keydown', onKey, true);
  });
}

export const styledAlert = (message) => styledConfirm(message, { okLabel: tr('Got it'), noCancel: true });

function createFolder() {
  styledPrompt(tr('New project folder'), {
    placeholder: tr('name (created in ~/claude-projects)'),
    okLabel: tr('Create'),
    onSubmit: async (name) => { await api('POST', '/api/projects/folders', { name }); await refresh(); },
  });
}
async function adoptFolder(name) {
  try { await api('POST', '/api/projects/folders', { name }); }
  catch (e) { styledAlert(e.message); return; }
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
  const close = overlayLayer(overlay);
  const err = (msg) => { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); };

  const stepType = () => {
    err('');
    body.innerHTML = WIZ_TYPES.map(([id, title, sub]) =>
      `<button type="button" class="wiz-type" data-type="${id}"><b>${esc(title)}</b><small>${esc(sub)}</small></button>`).join('');
    actions.innerHTML = `<button class="btn-ghost wiz-cancel">${tr('Cancel')}</button>`;
    actions.querySelector('.wiz-cancel').onclick = close;
    body.querySelectorAll('.wiz-type').forEach((b) => { b.onclick = () => stepForm(b.dataset.type); });
  };

  const stepForm = (type) => {
    err('');
    const withServer = type !== 'local';
    const withLocal = type !== 'server';
    const folders = state.folders.unregistered || [];
    let html = `<label class="pp-field">${tr('Project name')}<input id="wiz-name" type="text" placeholder="my project"></label>`
      + `<label class="pp-field">${tr('Key (slug + task prefix)')}<input id="wiz-slug" type="text" placeholder="my-project"></label>`;
    if (withLocal) {
      html += `<div class="pp-field">${tr('Project folder')}
        <div id="wiz-folder"></div>
        <div id="wiz-path-row" class="wiz-path-row hidden">
          <input id="wiz-path" type="text" placeholder="/full/path/to/the/folder">
          <button type="button" class="btn-ghost" id="wiz-browse">${tr('Choose…')}</button>
        </div>
        <div id="wiz-browser" class="wiz-browser hidden"></div>
        <input id="wiz-git" type="text" class="hidden" placeholder="git@github.com:me/repo.git or https://…"></div>`;
    }
    if (withServer) {
      html += `<label class="pp-field">${tr('SSH host')}<input id="wiz-server" type="text" placeholder="host for ssh (keys in ~/.ssh/config)"></label>`
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
    slugEl.oninput = () => { slugTouched = true; };
    nameEl.oninput = () => { if (!slugTouched) slugEl.value = wizSlugify(nameEl.value); };
    const folderSel = $('wiz-folder');
    if (folderSel) {
      const options = [
        ...(type === 'local' ? [{ value: '', label: tr('no folder — just a task list') }] : []),
        ...folders.map((f) => ({ value: f, label: `${tr('folder')} ${f} (${state.folders.root || '~'})` })),
        { value: '__manual__', label: tr('another folder on this computer…') },
        ...(type === 'localserver' ? [{ value: '__clone__', label: tr('clone from a git URL…') }] : []),
      ];
      const onFolderChange = (v) => {
        $('wiz-path-row').classList.toggle('hidden', v !== '__manual__');
        $('wiz-browser').classList.add('hidden');
        $('wiz-git').classList.toggle('hidden', v !== '__clone__');
        if (v === '__manual__') openFolderPicker();
      };
      buildSelect(folderSel, { value: type === 'local' ? '' : (options[0]?.value ?? ''), options, onChange: onFolderChange });
      $('wiz-browse').onclick = openFolderPicker;
    }
    const skillHost = $('wiz-skill');
    if (skillHost) {
      buildSelect(skillHost, { value: GENERIC_DEPLOY, options: skillOptions(GENERIC_DEPLOY, null) });
      api('GET', '/api/skills', null, { quiet: true })
        .then((info) => {
          if (!$('wiz-skill')) return;
          const generic = info.generic_deploy_skill || GENERIC_DEPLOY;
          const own = new Set(info.own_skills || []);
          const deployish = (info.items || []).filter((s) => s.name === generic || s.used_by?.length || own.has(s.name));
          const has = deployish.some((s) => s.name === generic);
          buildSelect($('wiz-skill'), { value: has ? generic : '', options: skillOptions(generic, deployish) });
        })
        .catch(() => {  });
    }
    actions.querySelector('.wiz-create').onclick = () => wizCreate(type).catch((e) => err(e.message));
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
        } else if (mode) {
          body.path = `${state.folders.root}/${mode}`;
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
      close();
      await refresh();
      selectProject(slug);
    } finally { btn.disabled = false; btn.textContent = tr('Create'); }
  };

  stepType();
}

export async function maybeOnboarding() {
  try {
    const st = await api('GET', '/api/onboarding');
    if (st.done) return;
    if (state.projects.length) { api('POST', '/api/onboarding', { done: true }); return; }
    openOnboarding();
  } catch {  }
}

function openOnboarding() {
  document.getElementById('onboarding')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'onboarding';
  overlay.innerHTML = `<div class="modal wiz onb">
    <div class="onb-steps"></div>
    <div class="modal-title"></div>
    <div class="wiz-body"></div>
    <div class="modal-err hidden"></div>
    <div class="modal-actions wiz-actions"></div>
  </div>`;
  document.body.appendChild(overlay);
  const title = overlay.querySelector('.modal-title');
  const body = overlay.querySelector('.wiz-body');
  const actions = overlay.querySelector('.wiz-actions');
  const stepsEl = overlay.querySelector('.onb-steps');
  const errEl = overlay.querySelector('.modal-err');
  const err = (msg) => { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); };
  const finish = (goDemo) => {
    api('POST', '/api/onboarding', { done: true }).catch(() => {});
    overlay.remove();
    refresh().then(() => { if (goDemo) selectProject('demo'); });
  };
  const STEPS = ['lang', 'sync', 'demo', 'done'];
  let demoCreated = false;
  const dots = (cur) => { stepsEl.innerHTML = STEPS.map((x) => `<span class="onb-dot${x === cur ? ' on' : ''}"></span>`).join(''); };

  const stepLang = () => {
    dots('lang'); err('');
    title.textContent = tr('Welcome!');
    body.innerHTML = `<div class="muted">${tr('This is a local kanban board built to work in tandem with Claude Code. A couple of steps and you are ready.')}</div>
      <div class="onb-langs">
        <button type="button" class="wiz-type${LANG === 'ru' ? ' active' : ''}" data-lang="ru"><b>Русский</b></button>
        <button type="button" class="wiz-type${LANG === 'en' ? ' active' : ''}" data-lang="en"><b>English</b></button>
      </div>`;
    actions.innerHTML = '';
    body.querySelectorAll('[data-lang]').forEach((b) => {
      b.onclick = async () => {
        setSetting('lang', b.dataset.lang);
        await syncLangToServer(b.dataset.lang);
        if (b.dataset.lang !== LANG) { location.reload(); return; }
        stepSync();
      };
    });
  };

  const stepSync = async () => {
    dots('sync'); err('');
    title.textContent = tr('GitHub sync (optional)');
    body.innerHTML = `<div class="muted">${tr('Every task can be mirrored to an issue and every project to a GitHub Project. Requires the gh CLI authenticated with the project scope (gh auth login && gh auth refresh -s project). You can also enable this later in Settings.')}</div>
      <div class="sync-cfg-row"><input type="text" id="onb-owner" placeholder="${tr('owner (GitHub user)')}"><input type="text" id="onb-repo" placeholder="${tr('owner/repo for issues')}"></div>
      <div class="muted" id="onb-gh-state"></div>`;
    actions.innerHTML = `<button class="btn-primary" id="onb-sync-on">${tr('Enable sync')}</button>
      <button class="btn-ghost" id="onb-sync-skip">${tr('Skip — work locally')}</button>`;
    api('GET', '/api/sync').then((st) => {
      const el = $('onb-gh-state');
      if (el) el.textContent = st.gh === false ? tr('gh CLI missing or not authenticated — you can enable sync later') : tr('gh CLI found and authenticated ✓');
    }).catch(() => {});
    $('onb-sync-skip').onclick = () => stepDemo();
    $('onb-sync-on').onclick = async () => {
      try {
        await api('POST', '/api/sync/config', { owner: $('onb-owner').value, repo: $('onb-repo').value });
        stepDemo();
      } catch (e) { err(e.message); }
    };
  };

  const stepDemo = () => {
    dots('demo'); err('');
    title.textContent = tr('Demo project');
    body.innerHTML = `<div class="muted">${tr('Create an example project with tasks in every column? It shows links, checklists and labels, and can be deleted with one click in the project settings.')}</div>`;
    actions.innerHTML = `<button class="btn-primary" id="onb-demo-yes">${tr('Create demo')}</button>
      <button class="btn-ghost" id="onb-demo-no">${tr('Skip')}</button>`;
    $('onb-demo-no').onclick = () => stepDone();
    $('onb-demo-yes').onclick = async () => {
      try { await api('POST', '/api/projects/demo', { lang: LANG }, { quiet: true }); demoCreated = true; } catch {  demoCreated = true; }
      stepDone();
    };
  };

  const stepDone = async () => {
    dots('done'); err('');
    title.textContent = tr('All set!');
    let packaged = false;
    try { packaged = !!(await api('GET', '/api/about', null, { quiet: true })).packaged; } catch {  }
    body.innerHTML = `<div class="muted">${tr('Claude can finish the setup for you — copy this and paste it into its chat:')}</div>`
      + setupPromptBlockHTML()
      + manualSetupHTML(packaged);
    wireSetupPrompt(body);
    actions.innerHTML = `<button class="btn-primary" id="onb-finish">${tr('Start working')}</button>`;
    $('onb-finish').onclick = () => finish(demoCreated);
  };

  if (localStorage.getItem('kb.set.lang') !== null) stepSync(); else stepLang();
}

export function renderTopbar() {
  $('project-menu').classList.toggle('hidden', [DASH, SETTINGS, HORIZON, CALENDAR, CHAOS].includes(state.slug));
  $('project-menu').classList.toggle('on', Boolean(state.projSettings));
  if (state.slug === DASH) {
    $('project-title').innerHTML = `${ic('chart', 15)} ${esc(tr('Dashboard'))}`;
    $('project-meta').textContent = '';
    return;
  }
  if (state.slug === HORIZON) { $('project-title').textContent = tr('Horizon'); $('project-meta').textContent = tr('goals by time horizon'); return; }
  if (state.slug === CALENDAR) { $('project-title').textContent = tr('Calendar'); $('project-meta').textContent = ''; return; }
  if (state.slug === CHAOS) { $('project-title').textContent = tr('Chaos'); $('project-meta').textContent = tr('quick task capture'); return; }
  if (state.slug === SETTINGS) {
    $('project-title').innerHTML = `${ic('gear', 15)} ${esc(tr('Settings'))}`;
    $('project-meta').textContent = '';
    return;
  }
  if (state.slug === ALL) {
    $('project-title').textContent = tr('All projects');
    $('project-meta').textContent = `${state.projects.length} ${plural(state.projects.length, 'project', 'projects')}`;
    return;
  }
  const p = currentProject();
  $('project-title').textContent = p ? (p.name || p.slug) : '—';
  $('project-meta').textContent = p ? [p.prefix, p.name !== p.slug ? p.slug : '', p.domain].filter(Boolean).join(' · ') : '';
}

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
