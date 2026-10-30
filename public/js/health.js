
import { $, HEALTH, LANG, api, esc, ic, state, tr } from './core.js';
import { keepFocus } from './now.js';
import { plural } from './settings.js';
import { selectProject } from './sidebar.js';
import { fileState, healthCounts, healthGroups, startTotal } from './health-rules.js';

const FRESH_MS = 30000;
const DOCS_URL = 'https://code.claude.com/docs/en/memory';
let last = null; // { at, d }
let drawnSig = '';
const opened = new Set(); // the projects whose files are unfolded — kept through repaints

const num = (n) => Number(n || 0).toLocaleString(LANG === 'ru' ? 'ru-RU' : 'en-US');
const size = (f) => `${num(f.lines)} ${plural(f.lines, 'line', 'lines')} · ${num(f.chars)} ${plural(f.chars, 'character', 'characters')}`;

const STATE_WORDS = {
  heavy: 'over 40,000 characters — Claude Code warns',
  long: 'over 200 lines',
  ok: 'within the norm',
};
function stateHTML(st) {
  return `<span class="hl-state hl-${st}">${st === 'ok' ? '✓ ' : ''}${esc(tr(STATE_WORDS[st]))}</span>`;
}

function kindWord(f) {
  if (f.kind === 'import') return `${tr('imported by')} ${f.from}`;
  return tr({
    main: 'the project\'s own', parent: 'from a folder above', local: 'personal, CLAUDE.local.md', rule: 'a rule without paths',
    memory: 'auto memory — the part that loads', user: 'yours, in every project', nested: 'loads when Claude works in that folder',
    scoped: 'a rule with paths: — loads when Claude works with its files',
  }[f.kind] || f.kind);
}
function fileHTML(f, norms) {
  const st = f.kind === 'memory' || f.kind === 'import' || f.kind === 'rule' ? null : fileState(f, norms);
  return '<div class="hl-file">'
    + `<span class="hl-file-path" title="${esc(f.path)}">${esc(f.path)}</span>`
    + `<span class="hl-file-kind">${esc(kindWord(f))}</span>`
    + `<span class="hl-file-size${st && st !== 'ok' ? ` hl-${st}` : ''}">${esc(size(f))}${f.skipped ? ` · ${esc(tr('over 4 MB — Claude Code skips it'))}` : ''}</span></div>`;
}

function projectHTML(p, d) {
  const { norms } = d;
  const total = startTotal(p, d.everywhere, norms);
  const st = p.main ? fileState(p.main, norms) : null;
  const what = p.main
    ? `<span class="hl-size">${esc(p.main.path)} · ${esc(size(p.main))}</span>${stateHTML(st)}`
    : `<span class="hl-size muted">${esc(tr('no CLAUDE.md of its own'))}</span>`;
  const start = `<span class="hl-start${total.over ? ' hl-heavy' : ''}" title="${esc(tr('Everything a session reads when it starts in this folder, with your own files'))}">`
    + `${esc(tr('at the start'))}: ${esc(num(total.chars))} ${esc(plural(total.chars, 'character', 'characters'))}</span>`;
  const files = [...p.files, ...p.nested];
  const body = files.length
    ? files.map((f) => fileHTML(f, norms)).join('')
    : `<div class="hl-file muted">${esc(tr('Claude Code reads nothing of this project at the start but your own files.'))}</div>`;
  return `<details class="hl-proj" data-slug="${esc(p.slug)}"${opened.has(p.slug) ? ' open' : ''}>`
    + `<summary class="hl-row">${ic('chevron', 13)}<span class="hl-main"><a class="hl-name" href="#" data-slug="${esc(p.slug)}">${esc(p.name)}</a>`
    + `<span class="hl-what">${what}</span></span>${start}</summary>`
    + `<div class="hl-files">${body}</div></details>`;
}

function normsHTML(d) {
  const n = d.norms;
  const row = (lead, why) => `<div class="hl-norm"><span class="hl-norm-n">${lead}</span><span class="muted">${why}</span></div>`;
  return '<div class="panel hl-norms">'
    + `<div class="hl-h">${tr('The norms')}<button type="button" class="btn-ghost hl-again">${tr('Check again')}</button></div>`
    + row(`${num(n.lines)} ${plural(n.lines, 'line', 'lines')}`, `${esc(tr('in one CLAUDE.md — the docs of Claude Code: a longer file takes more context, and Claude follows it worse'))} · <a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">${tr('the docs')}</a>`)
    + row(`${num(n.file_chars)} ${plural(n.file_chars, 'character', 'characters')}`, esc(tr('in one file — from here Claude Code itself warns «Large CLAUDE.md will impact performance» (on a window of 200k; on a larger window later)')))
    + row(`${num(n.total_chars)} ${plural(n.total_chars, 'character', 'characters')}`, esc(tr('in all the instructions of a session together — «Instruction files will impact performance»')))
    + `<div class="muted hl-hint">${esc(tr('A file imported with @ loads together with the CLAUDE.md and counts too. What is needed only now and then goes into .claude/rules with paths: or into the CLAUDE.md of a subfolder — they load only when Claude works with those files.'))}</div>`
    + '</div>';
}

function groupHTML(head, list, d, { fold = false } = {}) {
  if (!list.length) return '';
  const rows = `<div class="panel hl-list">${list.map((p) => (p.files ? projectHTML(p, d) : awayHTML(p))).join('')}</div>`;
  if (!fold) return `<div class="hl-sec-h">${esc(head)} <span class="hl-sec-n">${list.length}</span></div>${rows}`;
  return `<details class="hl-fold" data-fold="${esc(head)}"${opened.has(`fold:${head}`) ? ' open' : ''}><summary class="hl-sec-h">${ic('chevron', 13)}${esc(head)} <span class="hl-sec-n">${list.length}</span></summary>${rows}</details>`;
}
function awayHTML(p) {
  return `<div class="hl-row hl-away"><span class="hl-main"><a class="hl-name" href="#" data-slug="${esc(p.slug)}">${esc(p.name)}</a>`
    + `<span class="hl-what muted">${esc(p.folder ? `${tr('the folder is not on this computer')}: ${p.folder}` : tr('no folder is set for the project'))}</span></span></div>`;
}

function paint(d) {
  const { own, bare, away } = healthGroups(d.projects, d.norms);
  const n = healthCounts(own, d.norms);
  const sum = own.length
    ? `${tr('Own CLAUDE.md')}: ${own.length} · ${tr('over 200 lines')}: ${n.long} · ${tr('over 40,000 characters')}: ${n.heavy}`
    : tr('No project of the board has a CLAUDE.md of its own.');
  const mine = d.everywhere.files.length
    ? `<div class="panel hl-list"><details class="hl-proj" data-slug="__mine"${opened.has('__mine') ? ' open' : ''}><summary class="hl-row">${ic('chevron', 13)}`
      + `<span class="hl-main"><span class="hl-name">${tr('Yours, in every project')}</span><span class="hl-what"><span class="hl-size">${esc(size(d.everywhere))}</span></span></span></summary>`
      + `<div class="hl-files">${d.everywhere.files.map((f) => fileHTML(f, d.norms)).join('')}</div></details></div>`
    : '';
  const box = $('health');
  keepFocus(box, () => {
    box.innerHTML = `<div class="now-wrap hl-wrap">${normsHTML(d)}<div class="hl-sum muted">${esc(sum)}</div>${mine}`
      + groupHTML(tr('With a CLAUDE.md of its own'), own, d)
      + groupHTML(tr('Without one'), bare, d, { fold: true })
      + groupHTML(tr('No folder on this computer'), away, d, { fold: true }) + '</div>';
  });
  box.querySelectorAll('details[data-slug], details[data-fold]').forEach((el) => {
    el.ontoggle = () => {
      const k = el.dataset.slug || `fold:${el.dataset.fold}`;
      if (el.open) opened.add(k); else opened.delete(k);
    };
  });
  box.querySelectorAll('a.hl-name').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); selectProject(a.dataset.slug); };
  });
  box.querySelector('.hl-again').onclick = (e) => { e.currentTarget.disabled = true; renderHealth({ force: true }); };
}

let seq = 0;
/** Draw the section; the folders are walked again only when the last answer is older than FRESH_MS, or on `force`. */
export async function renderHealth({ force = false } = {}) {
  if (last && !force && Date.now() - last.at < FRESH_MS) {
    if (!$('health').firstChild) { drawnSig = ''; }
    const sig = JSON.stringify(last.d);
    if (sig !== drawnSig) { drawnSig = sig; paint(last.d); }
    return;
  }
  const my = ++seq;
  if (!last) $('health').innerHTML = `<div class="now-wrap"><div class="muted">${tr('Measuring the instructions of the projects…')}</div></div>`;
  let d;
  try { d = await api('GET', '/api/health', undefined, { quiet: true }); }
  catch {
    if (my !== seq || state.slug !== HEALTH) return;
    if (!last) $('health').innerHTML = `<div class="now-wrap"><div class="muted">${tr('Could not measure the instructions of the projects.')}</div></div>`;
    else { const b = $('health').querySelector('.hl-again'); if (b) b.disabled = false; }
    return; // a failed reload keeps the last picture
  }
  if (my !== seq) return;
  last = { at: Date.now(), d };
  if (state.slug !== HEALTH) return; // the person moved on; the answer waits for the next opening
  drawnSig = JSON.stringify(d);
  paint(d);
}
