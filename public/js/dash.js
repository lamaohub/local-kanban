
import { fmtWork } from './board.js';
import { $, ALL, LANG, api, esc, ic, state, tr } from './core.js';
import { openDrawer } from './drawer.js';
import { HEAT_LEGEND, RANGE_BTN, RANGE_LABEL, calendarHTML, dashPanel, doneBarsHTML, feedHTML, openStatusPicker, plural, statCard, streaks, timeHeatHTML, topProjHTML, waitingHTML } from './settings.js';
import { selectProject } from './sidebar.js';
import { refresh } from './sse.js';

export async function renderDashboard() {
  const dash = $('dashboard');
  if (!state.projects.length) {
    dash.innerHTML = `<div class="dash-wrap"><div class="panel demo-cta">
      <div class="demo-cta-title">${tr('The board is empty')}</div>
      <div class="muted">${tr('Add your own project with the "＋ Add project" row in the sidebar — or create a demo project with example tasks to look around. The demo can be deleted later in the project settings.')}</div>
      <div><button class="btn-primary" id="demo-create">${tr('Create demo project')}</button></div>
    </div></div>`;
    $('demo-create').onclick = async () => {
      $('demo-create').disabled = true;
      try { await api('POST', '/api/projects/demo', { lang: LANG }, { quiet: true }); } catch {  }
      await refresh();
      selectProject('demo');
    };
    return;
  }
  let d;
  try { d = await api('GET', `/api/dashboard?range=${state.dashRange}`); }
  catch { dash.innerHTML = `<div class="dash-wrap"><div class="muted">${tr('Could not load the dashboard.')}</div></div>`; return; }

  const s = d.summary;
  const rlab = RANGE_LABEL[d.range] || tr('this week');
  const phRange = `<span class="ph-sub">${rlab}</span>`;
  const den = s.done_period + s.active;
  const pct = den ? Math.round((s.done_period / den) * 100) : 0;
  const [cur, mx] = streaks(d.done_per_day);
  const cyc = s.cycle_hours_period != null ? `${s.cycle_hours_period.toFixed(1)} ${tr('h')}` : '—';
  const q = d.queue;
  const low = q.todo_ready <= 2;

  const cards = '<div class="dcards">'
    + statCard(tr('Done'), s.done_period, rlab)
    + statCard(tr('Active'), s.active, tr('queued and in progress'))
    + statCard(tr('Completed'), `${pct}%`, `${s.done_period} ${tr('of')} ${den} ${rlab}`)
    + statCard(tr('Work time'), fmtWork(s.work_seconds_period), rlab)
    + statCard('Streak', `${cur} ${tr('d')}`, `${tr('max')} ${mx} ${tr('d')}`)
    + statCard(tr('Task cycle'), cyc, `${tr('from created to done')} (${rlab})`)
    + '</div>';

  const rangeCtl = `<div class="dash-top"><div class="dash-range">${RANGE_BTN
    .map(([v, lab]) => `<button class="dr-btn${v === d.range ? ' active' : ''}" data-range="${v}">${tr(lab)}</button>`)
    .join('')}</div></div>`;

  const queue = `<div class="queue-strip${low ? ' low' : ''}">`
    + '<div class="qs-main">'
    + `<span class="qs-item" data-go="1" title="${esc(tr('open the all-projects board'))}"><b>${q.todo_ready}</b> ${plural(q.todo_ready, 'task', 'tasks')} ${tr('ready to work on')}</span>`
    + '<span class="muted">·</span>'
    + `<span class="qs-item" data-go="1" title="${esc(tr('open the all-projects board'))}">${q.backlog} ${tr('in the backlog')}</span>`
    + `${low ? `<span class="queue-warn">${ic('warn', 12)} ${tr('running out of tasks soon — time to plan')}</span>` : ''}`
    + '</div>'
    + `<div class="qs-note">${tr('“Ready to work on” are tasks in the To do column — they can be picked up right now. “In the backlog” are ideas not yet selected for work.')}</div>`
    + '</div>';

  const fun = d.fun.peak_hour != null
    ? `${ic('trend', 13)} ${tr('Tasks closed:')} ${d.fun.done_total}. ${tr('Busiest around')} ${d.fun.peak_hour}:00.`
    : `${ic('trend', 13)} ${tr('Tasks closed:')} ${d.fun.done_total}.`;

  dash.innerHTML = `<div class="dash-wrap">
    ${rangeCtl}
    ${dashPanel(tr('Waiting for you'), waitingHTML(d.waiting))}
    ${cards}
    ${queue}
    <div class="dash-2col">
      ${dashPanel(tr('Activity by day'), `${calendarHTML(d.heat_days, d.range_since)}<div class="heat-note">${rlab}</div>`, HEAT_LEGEND)}
      ${dashPanel(tr('When work happens'), timeHeatHTML(d.heat_time), phRange)}
    </div>
    <div class="dash-2col">
      ${dashPanel(tr('Top projects'), topProjHTML(d.top_projects), phRange)}
      ${dashPanel(tr('Done by day'), doneBarsHTML(d.done_per_day, d.range_since), phRange)}
    </div>
    ${dashPanel(tr('Recent activity'), feedHTML(d.recent))}
    <div class="fun-line">${fun}</div>
  </div>`;

  dash.querySelectorAll('[data-key]').forEach((el) => { el.onclick = () => openDrawer(el.dataset.key); });
  dash.querySelectorAll('.dr-btn').forEach((b) => { b.onclick = () => { state.dashRange = b.dataset.range; renderDashboard(); }; });
  dash.querySelectorAll('.wr-dot').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openStatusPicker(el, el.dataset.pick, el.dataset.cur); };
  });
  dash.querySelectorAll('.qs-item').forEach((el) => { el.onclick = () => selectProject(ALL); });
}

const dashTip = document.createElement('div');
dashTip.className = 'dash-tip hidden';
document.body.appendChild(dashTip);
function moveDashTip(x, y) {
  const r = dashTip.getBoundingClientRect();
  let left = x + 13; let top = y + 15;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 13;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 13;
  dashTip.style.left = `${left}px`;
  dashTip.style.top = `${top}px`;
}
let tipFor = null;
$('dashboard').addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { if (tipFor) { tipFor = null; dashTip.classList.add('hidden'); } return; }
  if (el !== tipFor) {
    tipFor = el;
    dashTip.innerHTML = `<span class="dt-n">${esc(el.dataset.tip)}</span>`
      + (el.dataset.tipSub ? `<span class="dt-d">${esc(el.dataset.tipSub)}</span>` : '');
    dashTip.classList.remove('hidden');
  }
  moveDashTip(e.clientX, e.clientY);
});
$('dashboard').addEventListener('mouseleave', () => { tipFor = null; dashTip.classList.add('hidden'); });
