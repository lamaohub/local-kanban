import { api, esc, seg, tr } from './core.js';
import { buildSelect } from './board.js';
import { EFFORTS, EFFORT_LABELS } from './launch-rules.js';
import { MODELS } from './chat-models.js';
import { refusalLine } from './unsaved.js';

export const KEEP = '***';
let cache = { at: 0, list: [] };
/** The profiles (names of their variables only), asked again after 10 s. */
export async function profiles(force = false) {
  if (force || Date.now() - cache.at > 10_000) {
    try { cache = { at: Date.now(), list: (await api('GET', '/api/profiles', undefined, { quiet: true })).profiles || [] }; } catch { cache.at = Date.now(); }
  }
  return cache.list;
}

/** Lines «NAME=value» of the editor → {NAME: value}; a line «NAME=•••» keeps the stored value. */
export function envOf(text) {
  const env = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    const k = (at < 0 ? line : line.slice(0, at)).trim();
    const v = at < 0 ? '' : line.slice(at + 1);
    env[k] = v.trim() === '•••' ? KEEP : v;
  }
  return env;
}

const row = (p) => `<div class="pf-row" data-id="${p.id || ''}">`
  + `<input class="pf-name" maxlength="40" value="${esc(p.name || '')}" placeholder="${esc(tr('name, e.g. Sonnet for simple work'))}">`
  + `<button type="button" class="btn-icon pf-del" title="${esc(tr('Remove'))}">✕</button>`
  + `<input class="pf-model" list="pf-models" value="${esc(p.model || '')}" placeholder="${esc(tr('model — as Claude Code is set'))}">`
  + `<div class="kbsel pf-effort" data-value="${esc(p.effort || '')}"></div>`
  + `<textarea class="pf-env" rows="2" placeholder="ANTHROPIC_BASE_URL=https://…&#10;ANTHROPIC_AUTH_TOKEN=…">${esc((p.env || []).map((k) => `${k}=•••`).join('\n'))}</textarea>`
  + `<div class="pf-btns"><button type="button" class="btn-ghost pf-save">${esc(tr('Save'))}</button><span class="pf-said muted" role="status"></span></div></div>`;

/** Settings → Claude Code → Launch profiles. */
export async function renderProfiles(box) {
  const list = await profiles(true);
  if (!box.isConnected) return;
  box.innerHTML = `<div class="pf-hint muted">${esc(tr('A model, how hard Claude thinks and the environment of a start — a project starts its tasks with its own, a task may pick another. The values of the variables stay on this computer: the page shows only their names, Claude gets them from a settings file, never on a command line. Not for the Claude app — it takes no settings.'))}</div>`
    + `<datalist id="pf-models">${MODELS.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</datalist>`
    + `<div class="pf-list">${list.map(row).join('')}</div>`
    + `<button type="button" class="btn-ghost" id="pf-add">${esc(tr('Add a profile'))}</button>`;
  const wireRow = (el) => {
    const effort = el.querySelector('.pf-effort');
    buildSelect(effort, { value: effort.dataset.value || '', options: [{ value: '', label: tr('As the page says') }, ...EFFORTS.map((v) => ({ value: v, label: tr(EFFORT_LABELS[v]) }))], onChange: (v) => { effort.dataset.value = v; } });
    const said = (s) => { el.querySelector('.pf-said').textContent = s; };
    el.querySelector('.pf-save').onclick = async () => {
      const body = { name: el.querySelector('.pf-name').value, model: el.querySelector('.pf-model').value, effort: effort.dataset.value || '', env: envOf(el.querySelector('.pf-env').value) };
      try {
        const saved = el.dataset.id ? await api('PATCH', `/api/profiles/${seg(el.dataset.id)}`, body, { quiet: true }) : await api('POST', '/api/profiles', body, { quiet: true });
        el.dataset.id = saved.id;
        el.querySelector('.pf-env').value = saved.env.map((k) => `${k}=•••`).join('\n');
        cache.at = 0;
        said(tr('Saved ✓'));
      } catch (e) { said(refusalLine(tr('Not saved'), e, tr)); }
    };
    el.querySelector('.pf-del').onclick = async () => {
      if (el.dataset.id) { try { await api('DELETE', `/api/profiles/${seg(el.dataset.id)}`, undefined, { quiet: true }); cache.at = 0; } catch (e) { said(refusalLine(tr('Not removed'), e, tr)); return; } }
      el.remove();
    };
  };
  box.querySelectorAll('.pf-row').forEach(wireRow);
  box.querySelector('#pf-add').onclick = () => {
    box.querySelector('.pf-list').insertAdjacentHTML('beforeend', row({}));
    const el = box.querySelector('.pf-list').lastElementChild;
    wireRow(el);
    el.querySelector('.pf-name').focus();
  };
}

/** A select of profiles on `host`: `none` — the label of «no profile of its own». */
export async function buildProfileSelect(host, value, none, onChange) {
  const list = await profiles();
  if (!host.isConnected) return list;
  buildSelect(host, { value: value == null ? '' : String(value), options: [{ value: '', label: none }, ...list.map((p) => ({ value: String(p.id), label: p.name }))], onChange: (v) => onChange(v === '' ? null : Number(v)) });
  host.dataset.value = value == null ? '' : String(value);
  return list;
}
