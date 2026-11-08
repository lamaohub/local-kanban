import { $, HEALTH, api, esc, fmtNum, ic, state, tr } from './core.js';
import { keepFocus } from './now.js';
import { plural } from './settings.js';
import { styledAlert, styledConfirm } from './sidebar.js';
import { refusalLine } from './unsaved.js';
import { openDrawer } from './drawer.js';
import { SHORT_MONTHS, STATUS_LABELS, launchInClaude, taskPromptText } from './sse.js';
import { chosenFree, commitWords, diffable, sizeWords, standGroups, standTotals, tickAll, tickable, whyWords, walkBarHTML } from './health-rules.js';

const POLL_MS = 2000; // while the walk runs
let last = null;
let drawnSig = '';
let poll = null;
const chosen = new Set(); // folders ticked by the person — kept through repaints
const opened = new Set(); // stands unfolded
const diffs = new Map(); // folder → the diff text, once asked for
let starting = false;

const gb = (n) => sizeWords(n, { tr, fmtNum });
const statusWord = (st) => STATUS_LABELS[st] || st;
function day(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const why = (s) => whyWords(s, { tr, plural, statusWord });

function rowHTML(s) {
  const name = s.path.split('/').pop();
  const box = tickable(s)
    ? `<input type="checkbox" class="st-pick" data-path="${esc(s.path)}"${chosen.has(s.path) ? ' checked' : ''} aria-label="${esc(`${tr('Remove')} ${name}`)}">`
    : '<span class="st-pick-gap"></span>';
  const key = s.key ? `<a class="hl-fix-key" href="#" data-key="${esc(s.key)}">${esc(s.key)}</a>${s.task ? ` <span class="muted">${esc(statusWord(s.task.status))}</span>` : ''}` : '';
  const head = `<span class="hl-main"><span class="hl-name" title="${esc(s.path)}">${esc(name)}</span>`
    + `<span class="hl-what"><span>${esc(s.project ? s.project.name : (s.repo_name || ''))}</span>${key ? `<span>${key}</span>` : ''}${s.branch && s.branch !== name ? `<span class="st-branch">${esc(s.branch)}</span>` : ''}`
    + `${s.state !== 'free' && s.state !== 'reading' ? `<span class="st-why">${esc(why(s))}</span>` : ''}</span></span>`
    + `<span class="hl-start st-size">${esc(gb(s.size))}${s.changed_at ? ` · ${esc(day(s.changed_at))}` : ''}</span>`;
  const commits = s.commits || [];
  if (!commits.length && !(s.state === 'unsent' && (s.dirty || s.ignored?.files))) return `<div class="hl-row st-row">${box}<span class="st-chev-gap"></span>${head}</div>`;
  const list = commits.map((c) => `<div class="hl-file"><span class="hl-file-path">${esc(c.sha.slice(0, 9))} ${esc(c.title)}</span>`
    + `<span class="hl-file-kind${c.found ? '' : ' hl-heavy'}">${esc(commitWords(c, tr))}</span></div>`).join('');
  const diff = diffable(s)
    ? (diffs.has(s.path) ? `<pre class="st-diff">${esc(diffs.get(s.path))}</pre>` : `<button type="button" class="btn-ghost st-diff-btn" data-path="${esc(s.path)}">${esc(tr('Show what is not in main'))}</button>`)
    : '';
  return `<details class="hl-proj st-proj" data-path="${esc(s.path)}"${opened.has(s.path) ? ' open' : ''}><summary class="hl-row st-row">${box}${ic('chevron', 13)}${head}</summary>`
    + `<div class="hl-files">${list}${diff}</div></details>`;
}

function groupHTML(head, list, hint = '') {
  if (!list.length) return '';
  return `<div class="hl-sec-h">${esc(tr(head))} <span class="hl-sec-n">${list.length}</span></div>${hint ? `<div class="muted hl-hint st-hint">${esc(tr(hint))}</div>` : ''}`
    + `<div class="panel hl-list">${list.map(rowHTML).join('')}</div>`;
}

function paint(d, tabs) {
  const g = standGroups(d.stands);
  const t = standTotals(d.stands);
  const picked = chosenFree(chosen, d.stands);
  const repos = d.repos.map((r) => `<div class="st-repo"><span class="hl-file-path">${esc(r.top)}</span><span class="muted">${r.free ? `${tr('free on the disk')}: ${esc(gb(r.free))}` : ''}${r.main ? ` · ${tr('measured against')} ${esc(r.main)}` : ` · ${tr('no main branch to measure against')}`}</span></div>`).join('');
  const walk = `${tr('Looked at')} ${hhmm(d.at)}`;
  const sum = t.n
    ? `${t.n} ${plural(t.n, 'stand', 'stands')} · ${gb(t.size)} · ${tr('can go')}: ${t.freeN} (${gb(t.freeSize)})`
    : (d.running ? '' : tr('No stands: the projects of the board have no git worktrees besides the main one.'));
  const head = '<div class="panel hl-norms">'
    + `<div class="hl-h">${tr('Stands')}<button type="button" class="btn-ghost st-again"${d.running ? ' disabled' : ''}>${tr('Check again')}</button></div>`
    + `<div class="muted hl-hint">${esc(tr('A stand is a git worktree of a task (.claude/worktrees/<KEY>) and its branch. «Can go» — nothing uncommitted, no ignored data the main checkout lacks (a .env, data/), and the changes of every commit are in main; the task you open checks each one again right before removing it, and never removes one with work not in main.'))}</div>`
    + `${repos}${d.running ? walkBarHTML(esc(tr('Looking at the stands…')), d.done, d.total) : `<div class="hl-sum muted">${esc(walk)}</div>`}</div>`;
  const bar = g.free.length
    ? `<div class="st-bar"><button type="button" class="btn-ghost st-all">${esc(picked.length === g.free.length ? tr('Untick all') : `${tr('Tick all that can go')} (${g.free.length})`)}</button>`
      + `<button type="button" class="btn-primary st-go"${picked.length && !starting ? '' : ' disabled'}>${esc(`${tr('Remove the ticked')} (${picked.length})`)}</button></div>`
    : '';
  const box = $('health');
  keepFocus(box, () => {
    box.innerHTML = `<div class="now-wrap hl-wrap">${tabs}${head}${sum ? `<div class="hl-sum muted">${esc(sum)}</div>` : ''}${bar}`
      + groupHTML('Can go', g.free)
      + groupHTML('Work not in main', g.unsent, 'Not removed by the task: it asks you what to do with each.')
      + groupHTML('Busy', g.busy)
      + groupHTML('Being looked at', g.reading) + '</div>';
  });
  box.querySelectorAll('details.st-proj').forEach((el) => {
    el.ontoggle = () => { if (el.open) opened.add(el.dataset.path); else opened.delete(el.dataset.path); };
  });
  box.querySelectorAll('.st-pick').forEach((c) => {
    c.onclick = (e) => e.stopPropagation(); // a tick in <summary> does not fold it
    c.onchange = () => { if (c.checked) chosen.add(c.dataset.path); else chosen.delete(c.dataset.path); repaint(); };
  });
  box.querySelectorAll('a.hl-fix-key').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDrawer(a.dataset.key); };
  });
  box.querySelectorAll('.st-diff-btn').forEach((b) => { b.onclick = () => showDiff(b.dataset.path, b); });
  const again = box.querySelector('.st-again');
  if (again) again.onclick = () => { again.disabled = true; renderStands(tabs, { force: true }); };
  const all = box.querySelector('.st-all');
  if (all) {
    all.onclick = () => {
      tickAll(chosen, d.stands);
      repaint();
    };
  }
  const go = box.querySelector('.st-go');
  if (go) go.onclick = () => removeChosen(go, tabs);
}
let lastTabs = '';
const sigOf = (d) => JSON.stringify([d, [...chosen], [...diffs.keys()], starting]);
function repaint() {
  if (!last || state.slug !== HEALTH) return;
  drawnSig = sigOf(last);
  paint(last, lastTabs);
}

async function showDiff(path, btn) {
  btn.disabled = true;
  try {
    const r = await api('GET', `/api/health/stands/diff?path=${encodeURIComponent(path)}`, undefined, { quiet: true });
    diffs.set(path, r.text || tr('Nothing differs from main.'));
    opened.add(path);
    repaint();
  } catch (e) {
    btn.disabled = false;
    styledAlert(refusalLine('Could not show the changes', e, tr));
  }
}

async function removeChosen(btn, tabs) {
  const paths = chosenFree(chosen, last?.stands);
  if (!paths.length || starting) return;
  starting = true;
  btn.disabled = true;
  try {
    let r;
    try { r = await api('POST', '/api/health/stands/task', { paths }, { quiet: true }); } catch (e) {
      const b = e.body || {};
      if (b.reason === 'cleanup-open' && b.key) {
        styledConfirm(`${tr('A cleanup of these stands is already open')}: ${b.key}.`, { okLabel: `${tr('Open')} ${b.key}` }).then((ok) => { if (ok) openDrawer(b.key); });
      } else styledAlert(refusalLine('Could not open the task', e, tr));
      return;
    }
    chosen.clear();
    repaint(); // the ticks go at once: the walk is fresh, and renderStands below would not draw again
    for (const t of r.tasks || []) await launchInClaude({ text: taskPromptText(t.key), project: t.project, keys: [t.key], btn });
  } finally {
    starting = false;
    renderStands(tabs).catch(() => {});
  }
}

let seq = 0;
let askedAt = 0;
const REASK_MS = 30000; // a finished picture changes only with a walk: the events of the board do not ask for it again
/** Draw the stands; `tabs` — the switch of the sections, drawn on top. Asks again every POLL_MS while the walk runs. */
export async function renderStands(tabs, { force = false } = {}) {
  lastTabs = tabs;
  if (!force && last && !last.running && Date.now() - askedAt < REASK_MS) {
    if (!$('health').querySelector('.st-again')) { drawnSig = ''; repaint(); }
    return;
  }
  clearTimeout(poll);
  const my = ++seq;
  askedAt = Date.now();
  if (!last) $('health').innerHTML = `<div class="now-wrap hl-wrap">${tabs}${walkBarHTML(esc(tr('Looking at the stands…')), 0, 0)}</div>`;
  let d;
  try { d = await api('GET', `/api/health/stands${force ? '?refresh=1' : ''}`, undefined, { quiet: true }); } catch (e) {
    if (my !== seq || state.slug !== HEALTH) return;
    if (!last) $('health').innerHTML = `<div class="now-wrap hl-wrap">${tabs}<div class="muted">${esc(refusalLine('Could not look at the stands', e, tr))}</div></div>`;
    else { askedAt = 0; const b = $('health').querySelector('.st-again'); if (b) b.disabled = false; } // a failed «Check again» can be pressed again
    return;
  }
  if (my !== seq || state.slug !== HEALTH) return;
  if (last && last.at !== d.at) diffs.clear(); // a new walk: what was not in main may have landed since
  last = d;
  const sig = sigOf(d);
  if (sig !== drawnSig || !$('health').querySelector('.st-bar, .st-again')) { drawnSig = sig; paint(d, tabs); }
  if (d.running) poll = setTimeout(() => { if (state.slug === HEALTH && $('health').querySelector('.st-again')) renderStands(tabs).catch(() => {}); }, POLL_MS);
}
/** The section was left: no more asking. */
export function stopStands() { clearTimeout(poll); seq += 1; }
