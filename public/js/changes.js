import { api, esc, ic, seg, tr } from './core.js';
import { getSetting } from './settings.js';
import { editorLink } from './editor-rules.js';
import { addRemark, remarksMessage } from './changes-rules.js';
import { WORDS_SAID } from './branch-rules.js';
import { wordsToClaude } from './drawer.js';
import { refusalLine } from './unsaved.js';

const remarks = new Map(); // task key → [{file, line, removed, code, text}]
let shown = null; // {key, project, data}
let ask = 0;

const lineHTML = (f, l) => {
  const num = l.t === '-' ? l.old : l.new;
  return `<div class="ch-line ch-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}" data-file="${esc(f.path)}" data-line="${num}"${l.t === '-' ? ' data-removed="1"' : ''} tabindex="0">`
    + `<span class="ch-n">${l.old ?? ''}</span><span class="ch-n">${l.new ?? ''}</span><span class="ch-t">${l.t === ' ' ? ' ' : l.t}</span><span class="ch-code">${esc(l.text)}${l.cut ? `<span class="ch-cut muted" title="${esc(tr('the line is longer — the rest is not shown'))}">…</span>` : ''}</span></div>`;
};
function fileHTML(f, folder) {
  const first = f.hunks.flatMap((h) => h.lines).find((l) => l.new)?.new || null;
  const open = editorLink(getSetting('editor'), folder ? `${folder}/${f.path}` : null, first);
  return `<div class="ch-file"><div class="ch-fh"><span class="ch-path">${esc(f.path)}</span>`
    + (f.untracked ? `<span class="ch-new muted">${esc(tr('new, not in git yet'))}</span>` : '')
    + `<span class="ch-sum">${f.add === null ? '' : `<span class="chat-add">+${f.add}</span> <span class="chat-del">−${f.del}</span>`}</span>`
    + (open ? `<a class="ch-open" href="${esc(open)}" title="${esc(tr('Open in the editor'))}">${ic('code', 12)}</a>` : '') + '</div>'
    + (f.big ? `<div class="ch-note muted">${esc(tr('too large to show here'))}</div>`
      : f.binary ? `<div class="ch-note muted">${esc(tr('a binary file'))}</div>` : f.hunks.map((h) => `<div class="ch-hunk">${esc(h.head)}</div>${h.lines.map((l) => lineHTML(f, l)).join('')}`).join(''))
    + (f.cut ? `<div class="ch-note muted">${esc(tr('the rest of this file is not shown'))}</div>` : '') + '</div>';
}
function remarksHTML(key) {
  const list = remarks.get(key) || [];
  if (!list.length) return `<div class="ch-hint muted">${esc(tr('Click a line to leave a remark on it — the remarks go to Claude in one message.'))}</div>`;
  return `<div class="ch-remarks"><div class="ch-rh">${esc(tr('Remarks'))}: ${list.length}</div>`
    + list.map((r, i) => `<div class="ch-remark"><span class="ch-rp">${esc(r.file)}:${r.line}</span><span class="ch-rt">${esc(r.text)}</span><button type="button" class="btn-icon ch-rx" data-i="${i}" title="${esc(tr('Remove'))}">✕</button></div>`).join('')
    + `<div class="ch-rbtns"><button type="button" class="btn-primary" id="ch-send">${esc(tr('Send to Claude'))}</button></div></div>`;
}
function paint(box) {
  const { key, data } = shown;
  if (!data.source) { box.innerHTML = `<div class="ch-empty muted">${esc(tr('The project has no git folder on this computer — nothing to show.'))}</div>`; return; }
  const head = data.source === 'copy'
    ? `${shown.attempt ? `${tr('Attempt {n}').replace('{n}', shown.attempt)} · ` : ''}${tr('The branch {branch} against {base}').replace('{branch}', data.branch).replace('{base}', data.base || 'main')}`
    : tr('The commits of the task in the project\'s folder');
  const parts = data.commits.map((c) => `<details class="ch-commit" open><summary><span class="ch-hash">${esc(c.hash.slice(0, 7))}</span> ${esc(c.subject)}</summary>${c.files.map((f) => fileHTML(f, data.folder)).join('')}`
    + (c.cut ? `<div class="ch-note muted">${esc(tr(c.files.length ? 'the rest of this commit is not shown — the changes are too large' : 'not read — the changes are too large'))}</div>` : '') + '</details>');
  if (data.uncommitted) {
    parts.push(`<details class="ch-commit" open><summary>${esc(tr('Not committed yet'))}${data.uncommitted.shared ? ` <span class="muted">· ${esc(tr('the folder is shared: this may be another task\'s work too'))}</span>` : ''}</summary>`
      + `${data.uncommitted.files.map((f) => fileHTML(f, data.folder)).join('')}</details>`);
  }
  box.innerHTML = `<div class="ch-head muted">${esc(head)}</div>`
    + (parts.length ? parts.join('') : `<div class="ch-empty muted">${esc(tr('No changes of this task yet.'))}</div>`)
    + (data.cut ? `<div class="ch-note muted">${esc(tr('Not everything is shown — the changes are too large.'))}</div>` : '')
    + `<div class="ch-dock" id="ch-dock">${remarksHTML(key)}</div>`
    + '<div class="ch-said muted" role="status"></div>';
  wire(box);
}
function paintDock(box) {
  const dock = box.querySelector('#ch-dock');
  if (dock) { dock.innerHTML = remarksHTML(shown.key); wireDock(box); }
}
function wireDock(box) {
  const { key, project } = shown;
  box.querySelectorAll('.ch-rx').forEach((b) => { b.onclick = () => { const l = remarks.get(key) || []; l.splice(Number(b.dataset.i), 1); remarks.set(key, l); paintDock(box); }; });
  const send = box.querySelector('#ch-send');
  if (send) send.onclick = async () => {
    const list = remarks.get(key) || [];
    if (!list.length) return;
    send.disabled = true;
    const text = remarksMessage(key, list, tr);
    const said = (s) => { const el = box.querySelector('.ch-said'); if (el) el.textContent = s; };
    said('');
    const r = await wordsToClaude({ key, project }, text, send);
    if (r.how === 'refused') { send.disabled = false; said(refusalLine(tr('Not sent'), r.error, tr)); return; } // the remarks stay
    const left = (remarks.get(key) || []).filter((x) => !list.includes(x)); // one added while these went stays
    if (left.length) remarks.set(key, left); else remarks.delete(key);
    if (shown?.key === key) { paintDock(box); said(tr(WORDS_SAID[r.how])); }
  };
}
function wire(box) {
  box.querySelectorAll('.ch-line').forEach((el) => {
    const open = () => {
      if (el.nextElementSibling?.classList.contains('ch-form')) { el.nextElementSibling.querySelector('textarea').focus(); return; }
      box.querySelectorAll('.ch-form').forEach((f) => f.remove());
      el.insertAdjacentHTML('afterend', `<div class="ch-form"><textarea rows="2" placeholder="${esc(tr('What is wrong here, what to do'))}"></textarea>`
        + `<div class="ch-fbtns"><button type="button" class="btn-ghost ch-cancel">${esc(tr('Cancel'))}</button><button type="button" class="btn-primary ch-add">${esc(tr('Add'))}</button></div></div>`);
      const form = el.nextElementSibling;
      const ta = form.querySelector('textarea');
      ta.focus();
      const add = () => {
        if (!ta.value.trim()) { form.remove(); return; }
        remarks.set(shown.key, addRemark(remarks.get(shown.key) || [], { file: el.dataset.file, line: Number(el.dataset.line), removed: el.dataset.removed === '1', code: el.querySelector('.ch-code').textContent, text: ta.value.trim() }));
        el.classList.add('ch-marked');
        form.remove();
        paintDock(box);
      };
      form.querySelector('.ch-add').onclick = add;
      form.querySelector('.ch-cancel').onclick = () => form.remove();
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); }
        if (e.key === 'Escape') { e.preventDefault(); form.remove(); el.focus(); }
        e.stopPropagation(); // the board's keys are not for this field
      };
    };
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } };
  });
  wireDock(box);
}

/** Draw the changes of `key` (of `project`) into `box`. */
export async function renderChanges(box, key, project, attempt = null) {
  const my = ++ask;
  if (shown?.key !== key || shown?.attempt !== attempt) box.innerHTML = `<div class="ch-empty muted">${esc(tr('Loading…'))}</div>`;
  let data;
  try { data = await api('GET', `/api/tasks/${seg(key)}/changes${attempt ? `?attempt=${attempt}` : ''}`, undefined, { quiet: true }); } catch {
    if (my === ask) box.innerHTML = `<div class="ch-empty muted">${esc(tr('Could not read the changes.'))}</div>`;
    return;
  }
  if (my !== ask) return;
  shown = { key, project, data, attempt };
  paint(box);
}
export const changesShown = () => shown?.key || null;
