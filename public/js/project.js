
import { buildSelect, selVal } from './board.js';
import { $, DASH, api, esc, ic, seg, state, tr } from './core.js';
import { confirmDiscard, currentProject, overlayLayer, popLayer, pushLayer, renderSidebar, renderTopbar, selectProject, styledAlert, styledConfirm } from './sidebar.js';
import { copyText, refresh } from './sse.js';
import { changedFields, refusalLine } from './unsaved.js';

function parsePm2Services(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  let list = null;
  if (text.startsWith('[')) {
    try { const v = JSON.parse(text); if (Array.isArray(v)) list = v; } catch {  }
  }
  return (list || text.split(',')).map((s) => String(s).trim()).filter(Boolean);
}

export function openProjectSettings(proj) {
  const p = proj || currentProject();
  if (!p) return;
  if (state.projSettings === p.slug) { closeProjectSettings(); return; }
  selectProject(p.slug, { settings: true });
}
export function closeProjectSettings() {
  if (!state.projSettings) return;
  selectProject(state.projSettings);
}

const FIELDS = { path: 'ps-path', server: 'ps-server', server_path: 'ps-spath', domain: 'ps-domain' };

let psSnap = null;
function projectValues(p) {
  const pm2 = parsePm2Services(p.pm2_services);
  const values = {
    name: (p.name || '').trim(), description: (p.description || '').trim(), category: p.category || 'Other',
    pinned: p.pinned ? 1 : 0, deploy_skill: (p.deploy_skill || '').trim() || null,
    pm2_services: pm2.length ? JSON.stringify(pm2) : null,
  };
  for (const field of Object.keys(FIELDS)) values[field] = (p[field] || '').trim() || null;
  return values;
}
function readProjectForm() {
  let category = $('ps-category').dataset.value;
  if (category === '__new__') category = $('ps-category-new').value.trim();
  const pm2 = $('ps-pm2').value.split(',').map((x) => x.trim()).filter(Boolean);
  const values = {
    name: $('ps-name').value.trim(), description: $('ps-desc').value.trim(), category,
    pinned: $('ps-pinned').checked ? 1 : 0, deploy_skill: (selVal($('ps-skill')) || '').trim() || null,
    pm2_services: pm2.length ? JSON.stringify(pm2) : null,
  };
  for (const [field, id] of Object.entries(FIELDS)) values[field] = $(id).value.trim() || null;
  return values;
}
export function projectSettingsDirty() {
  if (!psSnap || !$('ps-name') || $('projset').classList.contains('hidden')) return false;
  return Object.keys(changedFields(readProjectForm(), psSnap)).length > 0;
}
let leaveAsking = false;
async function askLeaveSettings() {
  if (leaveAsking) return false;
  leaveAsking = true;
  try {
    const r = await styledConfirm(tr('Save the changes of the project before leaving?'), { okLabel: tr('Save'), alt: tr("Don't save") });
    if (r === 'alt') return true;
    return r === true && await saveProjectSettings();
  } finally { leaveAsking = false; }
}
state.leaveGuard = () => !projectSettingsDirty() || askLeaveSettings();

export async function renderProjectSettings(force) {
  const host = $('projset');
  if (!host) return;
  const p = currentProject();
  if (!p) {
  host.innerHTML = `<div class="ps-wrap"><div class="muted">${tr('This project is gone')}</div></div>`;
    psSnap = null;
    return;
  }
  if (!force && host.dataset.slug === p.slug) return;
  host.dataset.slug = p.slug;

  const cur = p.category || 'Other';
  const cats = [...new Set([...state.categories.map((c) => c.name), ...state.projects.map((x) => x.category || 'Other')])]
    .sort((a, b) => tr(a).localeCompare(tr(b), 'ru'));
  if (!cats.includes(cur)) cats.unshift(cur);

  host.innerHTML = `<div class="ps-wrap">
    <div class="ps-head">
      <div>
        <div class="ps-title">${tr('Project settings')}</div>
        <div class="ps-sub muted">${esc(p.name || p.slug)} · ${esc(p.prefix || '')}${p.slug !== p.name ? ` · ${esc(p.slug)}` : ''}</div>
      </div>
      <button class="btn-ghost" id="ps-back">${tr('Back to the board')}</button>
    </div>

    <div class="panel ps-block">
      <div class="panel-h">${tr('Basics')}</div>
      <label class="pp-field">${tr('Name')}<input id="ps-name" type="text"></label>
      <div class="pp-field">${tr('Section')}
        <div class="pp-select" id="ps-category"></div>
        <input id="ps-category-new" type="text" placeholder="${tr('name of the new section')}" class="hidden">
      </div>
      <label class="pp-field">${tr('Description')}<textarea id="ps-desc" rows="3" placeholder="${tr('what this project is, notes…')}"></textarea></label>
      <label class="pp-field pp-toggle"><input id="ps-pinned" type="checkbox"><span>${tr('Pin to board')}</span></label>
    </div>

    <div class="panel ps-block">
      <div class="panel-h">${tr('Paths & deploy')}</div>
      <div class="kbh-note muted">${tr('“Local folder” is on this computer. The rest describes the server this project is deployed to — leave it empty and the project simply stays local.')}</div>
      <div class="ps-grid">
        <label class="pp-field">${tr('Local folder')}<input id="ps-path" type="text" placeholder="${tr('/path/to/the/folder — may be empty')}">
          <small class="ps-hint">${tr('where the code lies on this computer — Claude edits and commits it here')}</small></label>
        <label class="pp-field">${tr('Domain')}<input id="ps-domain" type="text" placeholder="example.com">
          <small class="ps-hint">${tr('opened after a deploy to check the site answers')}</small></label>
        <label class="pp-field">${tr('SSH host')}<input id="ps-server" type="text" placeholder="192.168.1.10">
          <small class="ps-hint">${tr('no key or password is entered here: access comes from your ~/.ssh/config, and a password will not do — a key is required. If ssh &lt;host&gt; works in your terminal, it works here.')}</small></label>
        <label class="pp-field">${tr('Server path')}<input id="ps-spath" type="text" placeholder="/var/www/my-project">
          <small class="ps-hint">${tr('where the project lies ON THE SERVER — the deploy pulls into this folder')}</small></label>
        <label class="pp-field">${tr('pm2 processes (comma-separated)')}<input id="ps-pm2" type="text" placeholder="my-api, my-web">
          <small class="ps-hint">${tr('restarted on the server after a deploy; empty means there is nothing to restart')}</small></label>
        <div class="pp-field">${tr('Deploy skill')}
          <div class="kbsel" id="ps-skill"></div>
          <small class="ps-hint" id="ps-skill-hint">${tr('the skill Claude follows to ship this project; “deploy” is the shared one. A new one is created in Settings → Skills.')}</small>
        </div>
      </div>
    </div>

    <div class="panel ps-block">
      <div class="panel-h">${tr('What Claude reads before working')}</div>
      <div class="kbh-note muted">${tr('The project notes and the deploy skill — Claude opens them before touching the code. Paths are absolute: copy one and paste it into the chat.')}</div>
      <div id="ps-docs" class="ps-docs">…</div>
    </div>

    <div class="ps-actions">
      <button id="ps-save" class="btn-primary">${tr('Save')}</button>
      <button id="ps-archive" class="btn-ghost" title="${tr('Hide the project from the list')}">${tr('Archive')}</button>
      <span id="ps-saved" class="muted ps-saved"></span>
      ${p.slug === 'demo' ? `<button id="ps-demo-del" class="btn-ghost pp-demo-del">${tr('Delete demo project entirely')}</button>` : ''}
    </div>
  </div>`;

  $('ps-name').value = p.name || '';
  $('ps-desc').value = p.description || '';
  $('ps-pinned').checked = !!p.pinned;
  $('ps-path').value = p.path || '';
  $('ps-server').value = p.server || '';
  $('ps-spath').value = p.server_path || '';
  $('ps-pm2').value = parsePm2Services(p.pm2_services).join(', ');
  $('ps-domain').value = p.domain || '';
  buildSkillSelect(p, null);
  loadSkillOptions(p);
  buildCatSelect(cur, cats);

  $('ps-back').onclick = closeProjectSettings;
  $('ps-save').onclick = saveProjectSettings;
  $('ps-archive').onclick = archiveProject;
  const demoDeleteBtn = $('ps-demo-del');
  if (demoDeleteBtn) {
    demoDeleteBtn.onclick = async () => {
      if (!await styledConfirm(tr('Delete the demo project and all its tasks?'), { okLabel: tr('Delete'), danger: true })) return;
      await api('DELETE', '/api/projects/demo');
      state.projSettings = null;
      state.slug = DASH;
      await refresh();
      selectProject(state.slug);
    };
  }
  host.querySelectorAll('input').forEach((inp) => {
    inp.onkeydown = (e) => { if (e.key === 'Enter') saveProjectSettings(); };
  });
  psSnap = projectValues(p);
  renderDocs(p);
}

export function deploySkills(info) {
  const generic = info?.generic_deploy_skill || 'deploy';
  const own = new Set(info?.own_skills || []);
  return (info?.items || []).filter((s) => s.name === generic || s.used_by?.length || own.has(s.name));
}

export function skillOptions(cur, list) {
  const names = list ? list.map((s) => s.name) : (cur ? [cur] : []);
  if (cur && !names.includes(cur)) names.unshift(cur);
  const known = new Set((list || []).map((s) => s.name));
  return [{ value: '', label: tr('not set — no deploy') }, ...names.map((name) => ({
    value: name,
    label: name === 'deploy' ? `${name} · ${tr('shared')}` : (list && !known.has(name) ? `${name} · ${tr('not installed')}` : name),
  }))];
}

function buildSkillSelect(p, list) {
  const host = $('ps-skill');
  if (!host) return;
  const cur = p.deploy_skill || '';
  buildSelect(host, { value: cur, options: skillOptions(cur, list) });
}
async function loadSkillOptions(p) {
  let info;
  try { info = await api('GET', '/api/skills', null, { quiet: true }); }
  catch { return; }
  if (!$('ps-skill') || $('projset').dataset.slug !== p.slug) return;
  buildSkillSelect(p, deploySkills(info));
}

async function renderDocs(p) {
  const box = $('ps-docs');
  if (!box) return;
  if (!p.path) {
    box.innerHTML = `<div class="muted">${tr('The project has no local folder — set one above and the notes will show up here.')}</div>`;
    return;
  }
  let info;
  try { info = await api('GET', `/api/projects/${seg(p.slug)}/docs`, null, { quiet: true }); }
  catch { box.innerHTML = '—'; return; }
  if (!$('ps-docs') || $('projset').dataset.slug !== p.slug) return;

  const row = (opts) => `<div class="ps-doc${opts.missing ? ' ps-doc-missing' : ''}">
      <span class="ps-doc-ic">${ic(opts.icon, 13)}</span>
      <span class="ps-doc-name">${esc(opts.title)}${opts.tag ? `<span class="ps-doc-tag">${esc(opts.tag)}</span>` : ''}</span>
      <span class="ps-doc-path" title="${esc(opts.path || '')}">${esc(opts.path || tr('not there'))}</span>
      <span class="ps-doc-act">
        ${opts.missing ? '' : `<button class="btn-icon ps-doc-open" data-open="${esc(opts.open)}" title="${tr('Open')}">${ic('eye', 13)}</button>`}
        ${opts.path ? `<button class="btn-icon ps-doc-copy" data-copy="${esc(opts.path)}" title="${tr('Copy the path')}">${ic('copy', 13)}</button>` : ''}
      </span>
    </div>`;

  const parts = info.docs.map((d) => row({
    icon: 'doc',
    title: d.name,
    path: d.path,
    missing: !d.exists,
    tag: d.exists ? '' : tr('no file'),
    open: `doc:${d.name}`,
  }));
  if (info.skill) {
    parts.push(row({
      icon: 'gear',
      title: info.skill.name,
      path: info.skill.real_path,
      missing: !info.skill.exists,
      tag: info.skill.generic ? tr('shared skill') : tr('own skill'),
      open: `skill:${info.skill.name}`,
    }));
  } else {
    parts.push(`<div class="ps-doc ps-doc-missing"><span class="ps-doc-ic">${ic('gear', 13)}</span>`
      + `<span class="ps-doc-name">${tr('Deploy skill')}<span class="ps-doc-tag">${tr('not set')}</span></span>`
      + `<span class="ps-doc-path">${tr('the field above takes a skill name — “deploy” is the shared one')}</span><span class="ps-doc-act"></span></div>`);
  }
  box.innerHTML = parts.join('');

  box.querySelectorAll('.ps-doc-copy').forEach((b) => {
    b.onclick = async () => {
      const was = b.innerHTML;
      b.innerHTML = await copyText(b.dataset.copy) ? '✓' : '✕';
      setTimeout(() => { b.innerHTML = was; }, 1200);
    };
  });
  box.querySelectorAll('.ps-doc-open').forEach((b) => {
    b.onclick = async () => {
      const [kind, name] = b.dataset.open.split(':');
      const url = kind === 'doc' ? `/api/projects/${seg(p.slug)}/docs/${seg(name)}` : `/api/skills/${seg(name)}`;
      try {
        const r = await api('GET', url);
        openFileEditor({
          title: kind === 'doc' ? name : `${name} · SKILL.md`,
          path: r.real_path || r.path,
          text: r.text || '',
          save: (text, confirmPath) => api('PUT', url, { text, confirm_path: confirmPath }),
          onSaved: () => renderDocs(p),
        });
      } catch (e) { styledAlert(refusalLine('Could not read the file', e, tr)); }
    };
  });
}

let fileEditorDirty = () => false;
export const fileEditorHasChanges = () => fileEditorDirty();
export function openFileEditor({ title, path, text, save, onSaved }) {
  $('file-viewer')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'file-viewer';
  overlay.innerHTML = `<div class="modal fv-modal">
    <div class="fv-head"><span class="fv-title">${esc(title)}</span><button class="btn-icon fv-close" title="${tr('Close')}">✕</button></div>
    <div class="fv-path muted">${esc(path || '')}</div>
    ${save
      ? `<textarea class="fv-body fv-edit" id="fv-text" spellcheck="false"></textarea>
         <div class="fv-actions">
           <button class="btn-primary" id="fv-save" disabled>${tr('Save to the file')}</button>
           <span class="muted fv-note" id="fv-note"></span>
         </div>`
      : `<pre class="fv-body">${esc(text)}</pre>`}
  </div>`;
  document.body.appendChild(overlay);
  let saved = text;
  const dirty = () => Boolean(save) && overlay.isConnected && $('fv-text').value !== saved;
  const close = overlayLayer(overlay, {
    confirmClose: () => !dirty() || confirmDiscard(),
    onClose: () => { fileEditorDirty = () => false; },
  });
  overlay.querySelector('.fv-close').onclick = close;
  if (!save) return;
  fileEditorDirty = dirty;
  const ta = $('fv-text');
  ta.value = text;
  const note = (msg) => { $('fv-note').textContent = msg; };
  const sync = () => { $('fv-save').disabled = ta.value === saved; };
  ta.oninput = () => { sync(); note(ta.value === saved ? '' : tr('changed — not written to the file yet')); };
  $('fv-save').onclick = async () => {
    const ok = await styledConfirm(`${tr('Overwrite this file?')}\n${path}`, { okLabel: tr('Overwrite'), danger: true });
    if (!ok) return;
    $('fv-save').disabled = true;
    try {
      const r = await save(ta.value, path);
      saved = ta.value;
      note(r?.backup_name ? `${tr('saved ✓ · the previous version is kept as')} ${r.backup_name}` : tr('saved ✓'));
      onSaved?.();
    } catch (e) { note(refusalLine('did not save', e, tr)); sync(); }
  };
}

let catDocHandler = null;
function closeCatList() {
  popLayer('ps-category');
  $('ps-category')?.classList.remove('open');
  if (catDocHandler) { document.removeEventListener('click', catDocHandler); catDocHandler = null; }
}
function buildCatSelect(cur, cats) {
  const box = $('ps-category');
  box.dataset.value = cur;
  const items = [...cats, '__new__'];
  const label = (v) => (v === '__new__' ? tr('New section…') : tr(v));
  box.innerHTML = `<button type="button" class="pp-sel-btn"><span class="pp-sel-val">${esc(label(cur))}</span><span class="pp-sel-chev">▾</span></button>`
    + `<div class="pp-sel-list">${items.map((v) =>
        `<div class="pp-sel-opt${v === cur ? ' active' : ''}" data-v="${esc(v)}">${v === '__new__' ? `${ic('plus', 12)} ${esc(tr('New section…'))}` : esc(label(v))}</div>`).join('')}</div>`;
  box.onclick = (e) => {
    const opt = e.target.closest('.pp-sel-opt');
    if (opt) {
      const v = opt.dataset.v; const isNew = v === '__new__';
      box.dataset.value = v;
      box.querySelector('.pp-sel-val').textContent = label(v);
      box.querySelectorAll('.pp-sel-opt').forEach((o) => o.classList.toggle('active', o.dataset.v === v));
      $('ps-category-new').classList.toggle('hidden', !isNew);
      if (isNew) $('ps-category-new').focus();
      closeCatList();
      return;
    }
    if (!e.target.closest('.pp-sel-btn')) return;
    if (box.classList.contains('open')) { closeCatList(); return; }
    box.classList.add('open');
    pushLayer('ps-category', closeCatList);
    catDocHandler = (ev) => { if (!box.contains(ev.target)) closeCatList(); };
    setTimeout(() => document.addEventListener('click', catDocHandler), 0);
  };
}

async function saveProjectSettings() {
  const p = currentProject();
  if (!p || !psSnap) return;
  const body = changedFields(readProjectForm(), psSnap);
  if (!body.name) delete body.name;
  if (!body.category) delete body.category;
  if (!Object.keys(body).length) { flashSaved(tr('nothing to save')); return true; }
  try { await api('PATCH', `/api/projects/${seg(p.slug)}`, body); }
  catch (e) { flashSaved(refusalLine('did not save', e, tr)); return false; }
  await refresh();
  renderSidebar();
  renderTopbar();
  await renderProjectSettings(true);
  flashSaved(tr('saved ✓'));
  return true;
}
function flashSaved(text) {
  const el = $('ps-saved');
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2200);
}

async function archiveProject() {
  const p = currentProject();
  if (!p) return;
  if (!await styledConfirm(`${tr('Archive')} "${p.name || p.slug}"? ${tr('Tasks are kept, the project leaves the list.')}`, { okLabel: tr('Archive') })) return;
  await api('PATCH', `/api/projects/${seg(p.slug)}`, { archived: 1 });
  state.projSettings = null;
  state.slug = DASH;
  await refresh();
  selectProject(state.slug);
}
