
import { $, NOW, api, esc, ic, state, tr } from './core.js';
import { openDrawer } from './drawer.js';
import { selectProject } from './sidebar.js';
import { SHORT_MONTHS, STATUS_LABELS } from './sse.js';
import { dropColumns, openRuns, syncColumns, termTaskOf } from './now-terms.js';
import { resumeOnBoard } from './sse.js';
import { localStore } from './store.js';
import { autoStripHTML, fillAutoSlots } from './automations.js';
import { PHONE_NOW_VIEW, onPhone } from './phone-rules.js';

const STALE_KEY = 'kb.ui.nowStale'; // is the "nobody is on these" list unfolded
let showStale = false;
try { showStale = localStore.getItem(STALE_KEY) === '1'; } catch { /* private mode: folded */ }
let last = null; // the last answer, so the minute repaint needs no request
const VIEW_KEY = 'kb.ui.nowView';
const VIEWS = ['list', 'terms', 'broken'];
let view = onPhone() ? PHONE_NOW_VIEW : 'list';
try { const v = localStore.getItem(VIEW_KEY); if (VIEWS.includes(v)) view = v; } catch { /* private mode: the default */ }

/** The runs a view of columns shows: 'terms' — the live ones, 'broken' — the ones with `ended`. */
export function runsOf(v, runs) {
  return v === 'broken' ? runs.filter((r) => r.ended) : runs.filter((r) => !r.stale && !r.ended);
}

/** A progress ring: the share of a full circle, drawn from the top clockwise. */
function ring(percent, size = 18) {
  const mid = size / 2;
  const r = mid - 2;
  const full = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<svg class="now-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">`
    + `<circle class="now-ring-track" cx="${mid}" cy="${mid}" r="${r}"/>`
    + (p ? `<circle class="now-ring-fill" cx="${mid}" cy="${mid}" r="${r}" stroke-dasharray="${(full * p / 100).toFixed(2)} ${full.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>` : '')
    + '</svg>';
}

// The board's own way with time (the card's history says "5 Oct 17:57"): 24 hours whatever the browser's locale —
// a Mac set to English would print "05:57 PM" on a Russian board. Today needs no date.
export function clock(s) {
  if (!s) return '';
  const d = new Date(`${String(s).replace(' ', 'T')}Z`); // the db keeps UTC
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${hm}`;
}
function waited(since) {
  if (!since) return '';
  const mins = Math.max(1, Math.round((Date.now() - since) / 60000));
  return mins < 60 ? `${mins} ${tr('min')}` : `${Math.floor(mins / 60)} ${tr('h')}`;
}

function runBadge(run) {
  if (run.claude === 'busy') return `<span class="card-live live-busy"><span class="live-dot"></span>${tr('working')}</span>`;
  if (run.claude === 'limit') return `<span class="card-live live-limit" title="${esc(tr('Claude hit the usage limit and stopped — it goes on once the limit resets'))}"><span class="live-dot"></span>${tr('limit reached')}${run.resets ? ` · ${tr('until')} ${esc(run.resets)}` : ''}</span>`;
  if (run.claude === 'background') return `<span class="card-live live-busy" title="${esc(tr('Claude goes on with commands running in the background — see its terminal'))}"><span class="live-dot"></span>${tr('working in the background')}</span>`;
  if (run.claude === 'waiting' || run.claude === 'idle') {
    const w = waited(run.since);
    return `<span class="card-live live-wait"><span class="live-dot"></span>${tr('waiting for you')}${w ? ` · ${w}` : ''}</span>`;
  }
  if (run.claude === 'gone') return `<span class="card-live live-gone"><span class="live-dot"></span>${tr(run.ended?.interrupted ? 'session interrupted' : 'session closed')}</span>`;
  if (run.claude === 'starting') return `<span class="card-live live-start" title="${esc(tr('Claude has been started on these tasks and has not taken them yet'))}"><span class="live-dot"></span>${tr('starting')}</span>`;
  if (run.claude === 'unsent') return `<span class="card-live live-wait" title="${esc(tr('The prompt is in the Claude app — press Enter there to start Claude'))}"><span class="live-dot"></span>${tr('waiting to start in the app')}</span>`;
  const stuck = Math.max(0, ...run.tasks.map((t) => t.stale_h));
  return stuck
    ? `<span class="card-live live-gone"><span class="live-dot"></span>${tr('stuck')} ${stuck}${tr('h')}</span>`
    : `<span class="card-live" title="${esc(tr('These tasks were moved without a Claude session the board knows — by hand, or by a kb that does not say which session it is'))}"><span class="live-dot"></span>${tr('no session data')}</span>`;
}

// the queue are gone — the owner asked what they were for: the badge of the run already says what its Claude does, and
// the line under the title says the stage and "working" or "next in line".
function wasHanded(t) {
  return t.status === 'review' || t.status === 'done';
}
function mark(t) {
  return wasHanded(t) ? `<span class="now-check" title="${esc(STATUS_LABELS[t.status])}">✓</span>` : '';
}

function taskLine(t, run, column) {
  const parts = [STATUS_LABELS[t.status] || t.status];
  const alive = run.claude === 'busy' || run.claude === 'background' || run.claude === 'waiting' || run.claude === 'idle';
  if (column) { /* the state is in the header */ } else if (t.focus) {
    if (run.claude === 'busy') parts.push(tr('working'));
    else if (run.claude === 'background') parts.push(tr('working in the background'));
    else if (alive) parts.push(tr('waiting for you'));
    else if (run.claude === 'gone') parts.push(tr('stopped here'));
  } else if (alive && (t.status === 'prep' || t.status === 'todo')) parts.push(tr('next in line'));
  if (t.blocked) parts.push(tr('blocked'));
  if (t.stale_h) parts.push(`${tr('stuck')} ${t.stale_h}${tr('h')}`);
  if (t.checklist_n) parts.push(`${tr('checklist')} ${t.checked_n}/${t.checklist_n}`);
  return parts.map(esc).join(' · ');
}

/** A task's title, or the first line of its description when it has none (a screenshot task). */
export function titleOf(t) {
  const title = (t.title || '').trim() || (t.preview || '').trim().split('\n')[0];
  return title ? esc(title) : `<span class="row-untitled">${tr('untitled')}</span>`;
}

export function projectLinks(tasks) {
  const names = new Map();
  for (const t of tasks) if (t.project && !names.has(t.project)) names.set(t.project, t.project_name || t.project);
  const title = esc(tr('Open the board of this project'));
  return [...names].map(([slug, name]) => `<a class="now-proj-link" href="#" data-slug="${esc(slug)}" title="${title}">${esc(name)}</a>`).join(', ');
}

export function keepFocus(box, paint) {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  let sel = null, nth = 0;
  if (el && el !== document.body && box?.contains?.(el) && el.classList?.length) {
    const q = (v) => String(v).replace(/["\\]/g, '\\$&');
    sel = el.tagName.toLowerCase() + '.' + el.classList[0]
      + [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}="${q(a.value)}"]`).join('');
    nth = Math.max(0, [...box.querySelectorAll(sel)].indexOf(el));
  }
  paint();
  if (!sel) return;
  const all = box.querySelectorAll(sel);
  (all[nth] || all[0])?.focus({ preventScroll: true });
}

export function wireRows(box, open) {
  box.querySelectorAll('.now-row').forEach((el) => {
    el.onclick = () => open(el.dataset.key);
    el.onkeydown = (e) => {
      if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== el) return;
      e.preventDefault(); e.stopPropagation();
      open(el.dataset.key);
    };
  });
}

/** Wire the project links of a section: the board opens, the row or column around the link does not react. */
export function wireProjectLinks(box) {
  box.querySelectorAll('.now-proj-link').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); selectProject(a.dataset.slug); };
  });
}

function runHead(run, column) {
  const since = run.session && run.started_at ? `<span class="now-since">${tr('since')} ${esc(clock(run.started_at))}</span>` : '';
  // a run without a session is a project's loose tasks, not one launch: nothing was handed in by it
  const handed = `${tr('handed in')} ${run.submitted_n} ${tr('of')} ${run.tasks_n}`;
  if (column) {
    return `${column.board ? '' : runBadge(run)}<span class="now-proj">${projectLinks(run.tasks)}</span>${since}`
      + (run.session ? `<span class="now-of">${esc(handed)}</span>` : '');
  }
  const progress = run.session
    ? `<span class="now-progress">${ring(run.percent, 22)}<b>${run.percent}%</b><span class="now-of">${esc(handed)}</span></span>`
    : '';
  const key = run.ended && run.board && run.session ? termTaskOf(run) : null;
  const resume = key ? `<button type="button" class="btn-primary now-resume" data-key="${esc(key)}" data-session="${esc(run.session)}" title="${esc(tr('Start Claude again in this terminal with its conversation — it waits for your word'))}">${esc(tr('Continue'))}</button>` : '';
  return `<span class="now-who">${runBadge(run)}<span class="now-proj">${projectLinks(run.tasks)}</span>${since}${resume}</span>${progress}`;
}

function runRows(run, column) {
  // the column of ✓ only in a run that handed something in — elsewhere the keys start at the edge
  const marks = run.tasks.some(wasHanded);
  const rows = run.tasks.map((t) => `<div class="now-row" data-key="${esc(t.key)}" tabindex="0" role="button">`
    + (marks ? `<span class="now-mk">${mark(t)}</span>` : '')
    + `<span class="now-main"><span class="now-t"><span class="now-key">${esc(t.key)}</span><span class="now-title">${titleOf(t)}</span></span>`
    + `<span class="now-sub">${taskLine(t, run, column)}</span></span>`
    + (column ? '' : `<span class="now-pct" title="${esc(t.checklist_n ? tr('by its checklist') : tr('by its stage'))}">${ring(t.percent)}<span>${t.percent}%</span></span>`)
    + '</div>').join('');
  return rows;
}

function runHTML(run) {
  return `<div class="panel now-run${run.stale ? ' stale' : ''}">`
    + `<div class="now-run-h">${runHead(run)}</div>`
    + `<div class="now-rows">${runRows(run)}</div></div>`;
}

function viewSwitch(d) {
  const b = (v, label, title, n = 0, short = '') => `<button type="button" class="dr-btn${view === v ? ' active' : ''}" data-view="${v}" role="tab" aria-selected="${view === v}" title="${esc(tr(title))}">`
    + (short ? `<span class="now-view-long">${esc(tr(label))}</span><span class="now-view-short">${esc(tr(short))}</span>` : esc(tr(label)))
    + `${n ? ` <span class="now-view-n">${n}</span>` : ''}</button>`;
  return `<div class="now-bar"><div class="dash-range" role="tablist">${b('list', 'List', 'The runs of Claude one under another')}`
    + `${b('terms', 'Terminals', 'The runs of Claude side by side, each with its terminal')}`
    + `${b('broken', 'Broken terminals', 'The runs whose Claude was stopped or whose terminal is gone — each with Continue', d ? runsOf('broken', d.runs).length : 0, 'Broken')}</div></div>`;
}

const EMPTY_HTML = () => `<div class="panel now-empty"><div class="now-empty-h">${tr('Claude is not working on anything right now')}</div>`
  + `<div class="muted">${tr('Tasks you start with ▶ on To do show up here — top to bottom, with how much is left.')}</div></div>`;
const BROKEN_EMPTY_HTML = () => `<div class="panel now-empty"><div class="now-empty-h">${tr('No broken terminals')}</div>`
  + `<div class="muted">${tr('A run whose Claude was stopped or whose terminal is gone (a restart of the computer) shows up here with Continue.')}</div></div>`;

// what nobody leads: folded under one line, the same in both views
function staleHTML(stale) {
  if (!stale.length) return '';
  const staleTasks = stale.reduce((n, r) => n + r.tasks.filter((t) => ['prep', 'doing', 'deploy'].includes(t.status)).length, 0);
  return `<button class="now-stale-h${showStale ? ' open' : ''}" type="button">${ic('chevron', 13)}`
    + `${tr('Nobody is on these')} <span class="now-stale-n">${staleTasks}</span>`
    + `<span class="now-stale-why">${tr('the session closed, or no movement for two hours')}</span></button>`
    + (showStale ? stale.map(runHTML).join('') : '');
}

function wireSection(box) {
  fillAutoSlots(box);
  wireRows(box, openDrawer);
  box.querySelectorAll('.now-resume').forEach((b) => {
    b.onclick = async () => { if (await resumeOnBoard({ key: b.dataset.key, session: b.dataset.session, btn: b })) renderNow(); };
  });
  wireProjectLinks(box);
  const fold = box.querySelector('.now-stale-h');
  if (fold) fold.onclick = () => {
    showStale = !showStale;
    try { localStore.setItem(STALE_KEY, showStale ? '1' : '0'); } catch { /* the choice lives until reload */ }
    paint(last);
  };
  box.querySelectorAll('.now-bar .dr-btn').forEach((b) => {
    b.onclick = () => {
      if (view === b.dataset.view) return;
      view = b.dataset.view;
      try { localStore.setItem(VIEW_KEY, view); } catch { /* the choice lives until reload */ }
      paint(last);
    };
  });
}

function paintTerms(d) {
  const box = $('now');
  let wide = box.querySelector(':scope > .now-wide');
  if (!wide) {
    box.innerHTML = '<div class="now-wide"><div class="now-bar-slot"></div><div class="now-cols"></div><div class="now-rest"></div></div>';
    wide = box.querySelector('.now-wide');
  }
  const live = openRuns(runsOf(view, d.runs));
  wide.querySelector('.now-bar-slot').innerHTML = viewSwitch(d) + autoStripHTML();
  syncColumns(wide.querySelector('.now-cols'), live, { head: runHead, tasks: runRows });
  wide.querySelector('.now-cols').classList.toggle('hidden', !live.length);
  wide.querySelector('.now-rest').innerHTML = live.length ? '' : view === 'broken' ? BROKEN_EMPTY_HTML() : EMPTY_HTML();
  wireSection(box);
}

function paint(d) {
  const box = $('now');
  box.classList.toggle('now-terms', view !== 'list');
  keepFocus(box, () => {
    if (view !== 'list') { paintTerms(d); return; }
    dropColumns();
    const live = d.runs.filter((r) => !r.stale);
    const html = viewSwitch(d) + autoStripHTML() + (live.length ? live.map(runHTML).join('') : EMPTY_HTML()) + staleHTML(d.runs.filter((r) => r.stale));
    box.innerHTML = `<div class="now-wrap">${html}</div>`;
    wireSection(box);
  });
}

/** Draw the section from a fresh answer of the server. */
let seq = 0;
export async function renderNow() {
  const my = ++seq;
  let d;
  try { d = await api('GET', '/api/now', undefined, { quiet: true }); }
  catch {
    if (!last && my === seq) $('now').innerHTML = `<div class="now-wrap"><div class="muted">${tr('Could not load what Claude is doing.')}</div></div>`;
    return; // a failed reload keeps the last picture rather than blanking it
  }
  // painted an old picture over the newer one, as review.js and done.js already refuse)
  if (state.slug !== NOW || my !== seq) return;
  last = d;
  paint(d);
}

// "waiting for you · 12 min" and "since 10:41" age: repaint them once a minute while the section is shown
setInterval(() => { if (last && !document.hidden && !$('now').classList.contains('hidden')) paint(last); }, 60000);
