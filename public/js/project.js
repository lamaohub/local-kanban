
import { $, DASH, api, esc, ic, seg, state, tr } from './core.js';
import { currentProject, popLayer, pushLayer, selectProject, styledConfirm } from './sidebar.js';
import { refresh } from './sse.js';

let projPanelSlug = null;
function placeProjectPanel(anchorRect) {
  const panel = $('proj-panel');
  if (!panel) return;
  const r = anchorRect || $('project-menu').getBoundingClientRect();
  const left = anchorRect ? r.left : Math.min(r.left, window.innerWidth - panel.offsetWidth - 12);
  panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - panel.offsetHeight - 8))}px`;
}
export function openProjectPanel(proj, anchorRect) {
  const p = proj || currentProject();
  if (!p) return;
  projPanelSlug = p.slug;
  closeProjectPanel();
  pushLayer('proj-panel', closeProjectPanel);
  const panel = document.createElement('div');
  panel.className = 'proj-panel';
  panel.id = 'proj-panel';
  panel.innerHTML = `
    <div class="pp-head">${tr('Project settings')}</div>
    <label class="pp-field">${tr('Name')}<input id="pp-name" type="text"></label>
    <div class="pp-field">${tr('Section')}
      <div class="pp-select" id="pp-category"></div>
      <input id="pp-category-new" type="text" placeholder="${tr('name of the new section')}" class="hidden">
    </div>
    <label class="pp-field">${tr('Description')}<textarea id="pp-desc" rows="3" placeholder="${tr('what this project is, notes…')}"></textarea></label>
    <label class="pp-field pp-toggle"><input id="pp-pinned" type="checkbox"><span>${tr('Pin to board')}</span></label>
    <button type="button" class="pp-more" id="pp-more">${tr('Paths & deploy ▾')}</button>
    <div class="pp-extra hidden" id="pp-extra">
      <label class="pp-field">${tr('Local folder')}<input id="pp-path" type="text" placeholder="${tr('/path/to/the/folder — may be empty')}"></label>
      <label class="pp-field">${tr('SSH host')}<input id="pp-server" type="text" placeholder="${tr('ssh alias or address')}"></label>
      <label class="pp-field">${tr('Server path')}<input id="pp-spath" type="text"></label>
      <label class="pp-field">${tr('pm2 processes (comma-separated)')}<input id="pp-pm2" type="text"></label>
      <label class="pp-field">${tr('Domain')}<input id="pp-domain" type="text"></label>
      <label class="pp-field">${tr('Deploy skill')}<input id="pp-skill" type="text" placeholder="${tr('empty = no deploy / deploy = the generic one')}"></label>
    </div>
    <div class="pp-actions">
      <button id="pp-save" class="btn-primary">${tr('Save')}</button>
      <button id="pp-archive" class="btn-ghost" title="${tr('Hide the project from the list')}">${tr('Archive')}</button>
    </div>
    ${p.slug === 'demo' ? `<button id="pp-demo-del" class="btn-ghost pp-demo-del">${tr('Delete demo project entirely')}</button>` : ''}`;
  document.body.appendChild(panel);
  $('pp-name').value = p.name || '';
  $('pp-desc').value = p.description || '';
  $('pp-pinned').checked = !!p.pinned;
  $('pp-path').value = p.path || '';
  $('pp-server').value = p.server || '';
  $('pp-spath').value = p.server_path || '';
  try { $('pp-pm2').value = JSON.parse(p.pm2_services || '[]').join(', '); } catch { $('pp-pm2').value = ''; }
  $('pp-domain').value = p.domain || '';
  $('pp-skill').value = p.deploy_skill || '';
  $('pp-more').onclick = () => {
    const ex = $('pp-extra');
    const open = ex.classList.toggle('hidden');
    $('pp-more').textContent = open ? tr('Paths & deploy ▾') : tr('Paths & deploy ▴');
    placeProjectPanel(anchorRect);
  };
  const cur = p.category || 'Other';
  const cats = [...new Set([...state.categories.map((c) => c.name), ...state.projects.map((x) => x.category || 'Other')])]
    .sort((a, b) => a.localeCompare(b, 'ru'));
  if (!cats.includes(cur)) cats.unshift(cur);
  buildCatSelect(cur, cats);
  placeProjectPanel(anchorRect);
  $('pp-save').onclick = saveProjectPanel;
  $('pp-archive').onclick = archiveProject;
  const demoDeleteBtn = $('pp-demo-del');
  if (demoDeleteBtn) {
    demoDeleteBtn.onclick = async () => {
      if (!await styledConfirm(tr('Delete the demo project and all its tasks?'), { okLabel: tr('Delete'), danger: true })) return;
      closeProjectPanel();
      await api('DELETE', '/api/projects/demo');
      if (state.slug === 'demo') state.slug = DASH;
      await refresh();
      selectProject(state.slug);
    };
  }
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'pp-name' || e.target.id === 'pp-category-new')) saveProjectPanel();
    if (e.key === 'Escape') closeProjectPanel();
  });
  $('pp-name').focus(); $('pp-name').select();
  setTimeout(() => document.addEventListener('click', projPanelOutside), 0);
}
let catDocHandler = null;
function closeCatList() {
  $('pp-category')?.classList.remove('open');
  if (catDocHandler) { document.removeEventListener('click', catDocHandler); catDocHandler = null; }
}
function buildCatSelect(cur, cats) {
  const box = $('pp-category');
  box.dataset.value = cur;
  const items = [...cats, '__new__'];
  const label = (v) => (v === '__new__' ? tr('New section…') : v);
  box.innerHTML = `<button type="button" class="pp-sel-btn"><span class="pp-sel-val">${esc(label(cur))}</span><span class="pp-sel-chev">▾</span></button>`
    + `<div class="pp-sel-list">${items.map((v) =>
        `<div class="pp-sel-opt${v === cur ? ' active' : ''}" data-v="${esc(v)}">${v === '__new__' ? `${ic('plus', 12)} ${esc(tr('New section…'))}` : esc(v)}</div>`).join('')}</div>`;
  box.onclick = (e) => {
    e.stopPropagation();
    const opt = e.target.closest('.pp-sel-opt');
    if (opt) {
      const v = opt.dataset.v; const isNew = v === '__new__';
      box.dataset.value = v;
      box.querySelector('.pp-sel-val').textContent = label(v);
      box.querySelectorAll('.pp-sel-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === v));
      $('pp-category-new').classList.toggle('hidden', !isNew);
      if (isNew) $('pp-category-new').focus();
      closeCatList();
      return;
    }
    if (!e.target.closest('.pp-sel-btn')) return;
    if (box.classList.contains('open')) { closeCatList(); return; }
    box.classList.add('open');
    catDocHandler = (ev) => { if (!box.contains(ev.target)) closeCatList(); };
    setTimeout(() => document.addEventListener('click', catDocHandler), 0);
  };
}
function projPanelOutside(e) {
  const panel = $('proj-panel');
  if (panel && !panel.contains(e.target) && e.target.id !== 'project-menu') closeProjectPanel();
}
function closeProjectPanel() {
  popLayer('proj-panel');
  closeCatList();
  $('proj-panel')?.remove();
  document.removeEventListener('click', projPanelOutside);
}
function projPanelTarget() { return state.projects.find((x) => x.slug === projPanelSlug) || currentProject(); }
async function saveProjectPanel() {
  const p = projPanelTarget();
  if (!p) return;
  const body = {};
  const name = $('pp-name').value.trim();
  const description = $('pp-desc').value.trim();
  if (name && name !== p.name) body.name = name;
  if (description !== (p.description || '')) body.description = description;
  let category = $('pp-category').dataset.value;
  if (category === '__new__') category = $('pp-category-new').value.trim();
  if (category && category !== (p.category || 'Other')) body.category = category;
  const pinned = $('pp-pinned').checked ? 1 : 0;
  if (pinned !== (p.pinned ? 1 : 0)) body.pinned = pinned;
  const reg = { path: 'pp-path', server: 'pp-server', server_path: 'pp-spath', domain: 'pp-domain', deploy_skill: 'pp-skill' };
  for (const [field, id] of Object.entries(reg)) {
    const v = $(id).value.trim() || null;
    if (v !== (p[field] || null)) body[field] = v;
  }
  const pm2 = $('pp-pm2').value.split(',').map((s) => s.trim()).filter(Boolean);
  const pm2Str = pm2.length ? JSON.stringify(pm2) : null;
  if (pm2Str !== (p.pm2_services || null)) body.pm2_services = pm2Str;
  closeProjectPanel();
  if (Object.keys(body).length) await api('PATCH', `/api/projects/${seg(p.slug)}`, body);
  await refresh();
}
async function archiveProject() {
  const p = projPanelTarget();
  if (!p) return;
  if (!await styledConfirm(`${tr('Archive')} "${p.name || p.slug}"? ${tr('Tasks are kept, the project leaves the list.')}`, { okLabel: tr('Archive') })) return;
  closeProjectPanel();
  await api('PATCH', `/api/projects/${seg(p.slug)}`, { archived: 1 });
  if (state.slug === p.slug) state.slug = null;
  await refresh();
}
