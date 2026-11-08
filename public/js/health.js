
import { $, HEALTH, LANG, api, esc, ic, state, tr } from './core.js';
import { liveBadge } from './board.js';
import { keepFocus } from './now.js';
import { plural } from './settings.js';
import { selectProject, styledAlert, styledConfirm } from './sidebar.js';
import { refusalLine } from './unsaved.js';
import { openDrawer } from './drawer.js';
import { STATUS_LABELS, launchInClaude, taskPromptText } from './sse.js';
import { fileState, fixStage, fixable, healthCounts, healthGroups, startTotal, walkBarHTML } from './health-rules.js';
import { renderStands, stopStands } from './health-stands.js';
import { localStore } from './store.js';

const TAB_KEY = 'kb.ui.healthTab';
const TABS = ['files', 'stands'];
let tab = 'files';
try { const v = localStore.getItem(TAB_KEY); if (TABS.includes(v)) tab = v; } catch { /* private mode: the first one */ }
function tabsHTML() {
  const b = (v, label, title) => `<button type="button" class="dr-btn${tab === v ? ' active' : ''}" data-hl-tab="${v}" role="tab" aria-selected="${tab === v}" title="${esc(tr(title))}">${esc(tr(label))}</button>`;
  return `<div class="now-bar hl-tabs"><div class="dash-range" role="tablist">${b('files', 'Instructions', 'How large the CLAUDE.md of each project is')}`
    + `${b('stands', 'Stands', 'The git worktrees left behind by tasks, and their branches')}</div></div>`;
}
// one listener on the section for the switch: both sections draw it anew on every paint
let tabsWired = false;
function wireTabs() {
  if (tabsWired) return;
  tabsWired = true;
  $('health').addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-hl-tab]');
    if (!b || b.dataset.hlTab === tab) return;
    tab = b.dataset.hlTab;
    try { localStore.setItem(TAB_KEY, tab); } catch { /* the choice lives until reload */ }
    drawnSig = '';
    if (tab !== 'stands') stopStands();
    renderHealth().catch(() => {});
  });
}

const FRESH_MS = 30000;
const DOCS_URL = 'https://code.claude.com/docs/en/memory';
let last = null; // { at, d }
let fixes = {};
let drawnSig = '';
const opened = new Set(); // the projects whose files are unfolded — kept through repaints

const num = (n) => Number(n || 0).toLocaleString(LANG === 'ru' ? 'ru-RU' : 'en-US');
const NB = '\u00a0';
const DOT = `${NB}· `;
const keepNumbers = (s) => String(s).replace(/(\d) /g, `$1${NB}`);
const size = (f) => `${num(f.lines)}${NB}${plural(f.lines, 'line', 'lines')}${DOT}${num(f.chars)}${NB}${plural(f.chars, 'character', 'characters')}`;

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
    ? `<span class="hl-size">${esc(p.main.path)}${DOT}${esc(size(p.main))}</span>${stateHTML(st)}`
    : `<span class="hl-size muted">${esc(tr('no CLAUDE.md of its own'))}</span>`;
  const start = `<span class="hl-start${total.over ? ' hl-heavy' : ''}" title="${esc(tr('Everything a session reads when it starts in this folder, with your own files'))}">`
    + `${esc(tr('at the start'))}: ${esc(num(total.chars))} ${esc(plural(total.chars, 'character', 'characters'))}</span>`;
  const button = `<button type="button" class="btn-ghost hl-fix" data-slug="${esc(p.slug)}" title="${esc(tr('Open the task «Shrink CLAUDE.md» and start Claude on it — only while nobody works in the folder of the project'))}">${esc(tr('Fix'))}</button>`;
  const fix = fixHTML(fixes[p.slug], p.main && fixable(p.main, norms) ? button : '');
  const files = [...p.files, ...p.nested];
  const body = files.length
    ? files.map((f) => fileHTML(f, norms)).join('')
    : `<div class="hl-file muted">${esc(tr('Claude Code reads nothing of this project at the start but your own files.'))}</div>`;
  return `<details class="hl-proj" data-slug="${esc(p.slug)}"${opened.has(p.slug) ? ' open' : ''}>`
    + `<summary class="hl-row">${ic('chevron', 13)}<span class="hl-main"><a class="hl-name" href="#" data-slug="${esc(p.slug)}">${esc(p.name)}</a>`
    + `<span class="hl-what">${what}</span></span>${start}${fix}</summary>`
    + `<div class="hl-files">${body}</div></details>`;
}

const statusWord = (st) => STATUS_LABELS[st] || st;
function fixHTML(fx, button) {
  const stage = fixStage(fx);
  if (stage === 'none') return button;
  const key = `<a class="hl-fix-key" href="#" data-key="${esc(fx.key)}" title="${esc(tr('Open the task of the fix'))}">${esc(fx.key)}</a>`;
  let what;
  if (stage === 'work') what = liveBadge({ id: fx.id, status: fx.status }) || `<span class="muted">${esc(statusWord(fx.status))} · ${esc(tr('Claude is not running'))}</span>`;
  else if (stage === 'review') what = `<span class="muted">${esc(tr('waits for your review'))}</span>`;
  else what = `<span class="muted">${esc(statusWord(fx.status))}</span>`;
  return `<span class="hl-fixing">${key}${what}${stage === 'todo' ? button : ''}</span>`;
}

function normsHTML(d) {
  const n = d.norms;
  const row = (lead, why) => `<div class="hl-norm"><span class="hl-norm-n">${lead}</span><span class="muted">${why}</span></div>`;
  return '<div class="panel hl-norms">'
    + `<div class="hl-h">${tr('The norms')}<button type="button" class="btn-ghost hl-again">${tr('Check again')}</button></div>`
    + row(`${num(n.lines)} ${plural(n.lines, 'line', 'lines')}`, `${esc(tr('in one CLAUDE.md — the docs of Claude Code: a longer file takes more context, and Claude follows it worse'))}${DOT}<a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">${tr('the docs')}</a>`)
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
    ? [[tr('Own CLAUDE.md'), own.length], [tr('over 200 lines'), n.long], [tr('over 40,000 characters'), n.heavy]].map(([w, k]) => `${keepNumbers(w)}:${NB}${k}`).join(DOT)
    : tr('No project of the board has a CLAUDE.md of its own.');
  const mine = d.everywhere.files.length
    ? `<div class="panel hl-list"><details class="hl-proj" data-slug="__mine"${opened.has('__mine') ? ' open' : ''}><summary class="hl-row">${ic('chevron', 13)}`
      + `<span class="hl-main"><span class="hl-name">${tr('Yours, in every project')}</span><span class="hl-what"><span class="hl-size">${esc(size(d.everywhere))}</span></span></span></summary>`
      + `<div class="hl-files">${d.everywhere.files.map((f) => fileHTML(f, d.norms)).join('')}</div></details></div>`
    : '';
  const box = $('health');
  keepFocus(box, () => {
    box.innerHTML = `<div class="now-wrap hl-wrap">${tabsHTML()}${normsHTML(d)}<div class="hl-sum muted">${esc(sum)}</div>${mine}`
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
  box.querySelectorAll('a.hl-fix-key').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDrawer(a.dataset.key); };
  });
  box.querySelectorAll('.hl-fix').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fixProject(b.dataset.slug, b); }; // a click in <summary> folds it
  });
}

const fixing = new Set(); // a second press while the first one opens and starts the task
/** The words of a refusal «Claude works there»: what holds the folder. */
export function busyWords(b) {
  const parts = [tr('Claude works in the folder of this project — fix its CLAUDE.md once that work is over.')];
  if (b.keys?.length) parts.push(`${tr('Tasks in work')}: ${b.keys.join(', ')}.`);
  if (b.sessions) parts.push(`${tr('Claude sessions at work there')}: ${b.sessions}.`);
  return parts.join(' ');
}
async function fixProject(slug, btn) {
  if (!slug || fixing.has(slug)) return;
  fixing.add(slug);
  btn.disabled = true;
  try {
    let r;
    try { r = await api('POST', '/api/health/fix', { project: slug }, { quiet: true }); } catch (e) {
      const b = e.body || {};
      if (b.reason === 'busy') styledAlert(busyWords(b));
      else if (b.reason === 'review' && b.key) {
        styledConfirm(`${tr('The last fix of this CLAUDE.md waits for your review')}: ${b.key}.`, { okLabel: `${tr('Open')} ${b.key}` })
          .then((ok) => { if (ok) openDrawer(b.key); });
      } else styledAlert(refusalLine('Could not open the task', e, tr));
      return;
    }
    await launchInClaude({ text: taskPromptText(r.key), project: slug, keys: [r.key], btn });
  } finally {
    fixing.delete(slug);
    btn.disabled = false;
  }
  renderHealth().catch(() => {});
}

const WALK_POLL_MS = 300;
const walkBar = (done = 0, total = 0) => walkBarHTML(esc(tr('Measuring the instructions of the projects…')), done, total, 'files');
function watchWalk(my) {
  let stopped = false;
  let timer = 0;
  const tick = async () => {
    let p;
    try { p = await api('GET', '/api/health/progress', undefined, { quiet: true }); } catch { p = null; }
    if (stopped || my !== seq) return;
    const el = $('health').querySelector('.hl-walk[data-walk="files"]');
    if (p && p.total && el) el.outerHTML = walkBar(p.done, p.total);
    timer = setTimeout(tick, WALK_POLL_MS);
  };
  timer = setTimeout(tick, WALK_POLL_MS / 2);
  return () => { stopped = true; clearTimeout(timer); };
}

let seq = 0;
/** Draw the section; the folders are walked again only when the last answer is older than FRESH_MS, or on `force`. */
export function repaintHealth() {
  if (state.slug !== HEALTH || tab !== 'files' || !last || !$('health').firstChild) return;
  const sig = sigOf(last.d);
  if (sig !== drawnSig) { drawnSig = sig; paint(last.d); }
}
// the badge itself, not only state.live: a question of its Claude (hasAsk) outranks the state of the session
const sigOf = (d) => JSON.stringify([d, fixes, Object.values(fixes).map((f) => liveBadge({ id: f.id, status: f.status }))]);
async function loadFixes() {
  try { fixes = (await api('GET', '/api/health/fixes', undefined, { quiet: true })).fixes || {}; } catch { /* the last ones stay */ }
}
export async function renderHealth({ force = false } = {}) {
  wireTabs();
  if (tab === 'stands') return renderStands(tabsHTML());
  if (last && !force && Date.now() - last.at < FRESH_MS) {
    await loadFixes();
    if (state.slug !== HEALTH || tab !== 'files') return;
    if (!$('health').firstChild) { drawnSig = ''; }
    const sig = sigOf(last.d);
    if (sig !== drawnSig) { drawnSig = sig; paint(last.d); }
    return;
  }
  const my = ++seq;
  const box = $('health');
  // an event of the board while the walk goes keeps the bar where it is — drawn anew it would jump back to zero
  if (!box.querySelector('.hl-walk[data-walk="files"]')) {
    if (!last || !box.querySelector('.hl-again')) box.innerHTML = `<div class="now-wrap hl-wrap">${tabsHTML()}${walkBar()}</div>`;
    else box.querySelector('.hl-sum')?.insertAdjacentHTML('beforebegin', walkBar()); // «Check again»: the last picture stays, the bar over it
  }
  const stopWatch = watchWalk(my);
  let d;
  try { [d] = await Promise.all([api('GET', '/api/health', undefined, { quiet: true }), loadFixes()]); }
  catch {
    stopWatch();
    if (my !== seq || state.slug !== HEALTH) return;
    if (tab !== 'files') return;
    if (!last) $('health').innerHTML = `<div class="now-wrap hl-wrap">${tabsHTML()}<div class="muted">${tr('Could not measure the instructions of the projects.')}</div></div>`;
    else { $('health').querySelector('.hl-walk')?.remove(); const b = $('health').querySelector('.hl-again'); if (b) b.disabled = false; }
    return; // a failed reload keeps the last picture
  }
  stopWatch();
  if (my !== seq) return;
  last = { at: Date.now(), d };
  if (state.slug !== HEALTH || tab !== 'files') return; // the person moved on; the answer waits for the next opening
  drawnSig = sigOf(d);
  paint(d);
}
