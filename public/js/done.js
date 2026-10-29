
import { $, DONE, api, esc, state, tr } from './core.js';
import { openDrawer } from './drawer.js';
import { clock, keepFocus, projectLinks, titleOf, wireProjectLinks, wireRows } from './now.js';
import { STATUS_LABELS } from './sse.js';
import { localStore } from './store.js';

let last = null; // the last answer
const VIEW_KEY = 'kb.ui.doneView';
const VIEWS = ['runs', 'time'];
let view = 'runs';
try { const v = localStore.getItem(VIEW_KEY); if (VIEWS.includes(v)) view = v; } catch { /* private mode: the default */ }

const whenOf = (t) => t.done_at || t.handed_at; // the time a row shows — and the one the list by time sorts on

function rowHTML(t, { project = false } = {}) {
  const status = esc(STATUS_LABELS[t.status] || t.status);
  return `<div class="now-row" data-key="${esc(t.key)}" tabindex="0" role="button">`
    + `<span class="now-mk">${t.status === 'done' ? `<span class="now-check" title="${esc(STATUS_LABELS.done)}">✓</span>` : `<span class="now-queue" title="${esc(STATUS_LABELS.review)}"></span>`}</span>`
    + `<span class="now-main"><span class="now-t"><span class="now-key">${esc(t.key)}</span><span class="now-title">${titleOf(t)}</span></span>`
    + `<span class="now-sub">${project ? `${esc(t.project_name || t.project)} · ${status}<span class="done-sub-when"> · ${esc(clock(whenOf(t)))}</span>` : status}</span></span>`
    + `<span class="rv-when">${esc(clock(whenOf(t)))}</span></div>`;
}

export function byTime(runs) {
  const seen = new Set();
  const tasks = [];
  for (const r of runs) for (const t of r.tasks) if (!seen.has(t.key)) { seen.add(t.key); tasks.push(t); }
  return tasks.sort((a, b) => String(whenOf(b) || '').localeCompare(String(whenOf(a) || '')) || b.id - a.id);
}

function viewSwitch() {
  const b = (v, label, title) => `<button type="button" class="dr-btn${view === v ? ' active' : ''}" data-view="${v}" role="tab" aria-selected="${view === v}" title="${esc(tr(title))}">${esc(tr(label))}</button>`;
  return `<div class="now-bar"><div class="dash-range" role="tablist">${b('runs', 'By run', 'Grouped by run, the run Claude finished last on top')}`
    + `${b('time', 'By time', 'Every task in one list, the latest on top')}</div></div>`;
}

function runHTML(run) {
  const counts = [
    run.review_n ? `${tr('in review')} ${run.review_n}` : '',
    run.done_n ? `${tr('accepted')} ${run.done_n}` : '',
  ].filter(Boolean).join(' · ');
  const when = `${tr('finished')} ${clock(run.finished_at)}`;
  const loose = run.session ? '' : `<span class="done-loose" title="${esc(tr('Handed in without a Claude session the board knows — put together by project and time'))}">${esc(tr('no session data'))}</span>`;
  const rows = run.tasks.map((t) => rowHTML(t)).join('');
  return '<div class="panel now-run done-run">'
    + `<div class="now-run-h"><span class="now-who"><span class="now-proj">${projectLinks(run.tasks)}</span>`
    + `<span class="now-since">${esc(when)}</span>${loose}</span>`
    + `<span class="done-n">${esc(counts)}</span></div>`
    + `<div class="now-rows">${rows}</div></div>`;
}

function paint(d) {
  const list = () => `<div class="panel now-run done-run done-time"><div class="now-rows">${byTime(d.runs).map((t) => rowHTML(t, { project: true })).join('')}</div></div>`;
  const html = d.runs.length
    ? viewSwitch() + (view === 'time' ? list() : d.runs.map(runHTML).join(''))
    : `<div class="panel now-empty"><div class="now-empty-h">${tr('Claude has not finished anything in the last 7 days')}</div>`
      + `<div class="muted">${tr('A run shows up here when Claude has handed in all of its tasks — a batch started with ▶ or a single task.')}</div></div>`;
  keepFocus($('done'), () => { $('done').innerHTML = `<div class="now-wrap">${html}</div>`; });
  wireRows($('done'), openDrawer);
  wireProjectLinks($('done'));
  $('done').querySelectorAll('.now-bar .dr-btn').forEach((b) => {
    b.onclick = () => {
      if (view === b.dataset.view) return;
      view = b.dataset.view;
      try { localStore.setItem(VIEW_KEY, view); } catch { /* the choice lives until reload */ }
      paint(last);
    };
  });
}

let seq = 0;
/** Draw the section from a fresh answer of the server. */
export async function renderDone() {
  const my = ++seq;
  let d;
  try { d = await api('GET', '/api/done', undefined, { quiet: true }); }
  catch {
    if (!last && my === seq) $('done').innerHTML = `<div class="now-wrap"><div class="muted">${tr('Could not load what Claude has finished.')}</div></div>`;
    return; // a failed reload keeps the last picture rather than blanking it
  }
  if (state.slug !== DONE || my !== seq) return; // the person moved on, or a newer request is on its way
  last = d;
  paint(d);
}
