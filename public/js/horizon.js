
import { $, LANG, api, esc, seg, tr } from './core.js';
import { DOW, isoWeek, ymdLocal } from './settings.js';
import { styledPrompt } from './sidebar.js';
import { SHORT_MONTHS } from './sse.js';

const HZ_TRASH = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M5 4l.5 9a1 1 0 0 0 1 .95h3a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
const HORIZON_SCALES = [['days', tr('Days')], ['weeks', tr('Weeks')], ['months', tr('Months')], ['years', tr('Years')]];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = LANG === 'ru'
  ? ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
  : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let horizonScale = 'months';
let calMonth = null; // {y, m}
const pad2 = (n) => String(n).padStart(2, '0');
const weekKey = (d) => `${d.getFullYear()}-W${pad2(isoWeek(d))}`;
const hzSaveTimers = {};
const hzAdd = (scale, period, text) => api('POST', '/api/horizons', { scale, period, text });
const hzPatch = (id, body) => api('PATCH', `/api/horizons/${seg(id)}`, body);
const deleteHorizonGoal = (id) => api('DELETE', `/api/horizons/${seg(id)}`);
function hzScheduleSave(id, text) { clearTimeout(hzSaveTimers[id]); hzSaveTimers[id] = setTimeout(() => hzPatch(id, { text }).catch(() => {}), 450); }

function goalRowHTML(g) {
  return `<div class="hz-goal${g.done ? ' done' : ''}" data-id="${g.id}">`
    + `<button class="hz-check" data-act="toggle">${g.done ? '✓' : ''}</button>`
    + `<input class="hz-text" data-act="text" value="${esc(g.text)}" placeholder="${tr('goal')}"${g.done ? ' readonly' : ''}>`
    + `<button class="hz-del" data-act="del" title="${tr('delete')}">${HZ_TRASH}</button></div>`;
}
function wireGoals(container, afterChange) {
  container.querySelectorAll('.hz-goal').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="toggle"]').onclick = async () => { await hzPatch(id, { done: !row.classList.contains('done') }).catch(() => {}); afterChange(); };
    const inp = row.querySelector('[data-act="text"]');
    if (inp && !inp.readOnly) inp.oninput = () => hzScheduleSave(id, inp.value);
    row.querySelector('[data-act="del"]').onclick = async () => { await deleteHorizonGoal(id).catch(() => {}); afterChange(); };
  });
  container.querySelectorAll('.hz-add-input').forEach((inp) => {
    inp.onkeydown = async (e) => {
      if (e.key === 'Enter' && inp.value.trim()) { await hzAdd(inp.dataset.scale, inp.dataset.period, inp.value.trim()).catch(() => {}); afterChange(inp.dataset.period); }
    };
  });
}

function horizonColumns(scale) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const cols = [];
  if (scale === 'years') {
    const y = now.getFullYear();
    for (let i = -1; i <= 3; i++) cols.push({ period: String(y + i), label: String(y + i), cur: i === 0 });
  } else if (scale === 'months') {
    for (let i = -1; i <= 4; i++) { const d = new Date(now.getFullYear(), now.getMonth() + i, 1); cols.push({ period: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, label: MONTHS[d.getMonth()], sub: String(d.getFullYear()), cur: i === 0 }); }
  } else if (scale === 'weeks') {
    const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    for (let i = -1; i <= 4; i++) { const d = new Date(mon); d.setDate(d.getDate() + i * 7); cols.push({ period: weekKey(d), label: `W${isoWeek(d)}`, sub: `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`, cur: i === 0 }); }
  } else {
    for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() + i); cols.push({ period: ymdLocal(d), label: tr(WEEKDAYS[d.getDay()]), sub: `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`, cur: i === 0 }); }
  }
  return cols;
}

export async function renderHorizon(focusPeriod) {
  const el = $('horizon');
  let goals = [];
  try { goals = await api('GET', `/api/horizons?scale=${horizonScale}`); } catch {  }
  const byP = {};
  for (const g of goals) (byP[g.period] ||= []).push(g);
  const cols = horizonColumns(horizonScale);
  el.innerHTML = `<div class="hz-wrap">
    <div class="hz-scales">${HORIZON_SCALES.map(([v, l]) => `<button class="hz-scale${v === horizonScale ? ' active' : ''}" data-scale="${v}">${l}</button>`).join('')}</div>
    <div class="hz-cols">${cols.map((c) => `<div class="hz-col${c.cur ? ' cur' : ''}">
        <div class="hz-col-h">${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>
        <div class="hz-goals">${(byP[c.period] || []).map(goalRowHTML).join('')}
          <input class="hz-add-input" placeholder="${tr('Add…')}" data-scale="${horizonScale}" data-period="${c.period}"></div>
      </div>`).join('')}</div>
  </div>`;
  el.querySelectorAll('.hz-scale').forEach((b) => { b.onclick = () => { horizonScale = b.dataset.scale; renderHorizon(); }; });
  wireGoals(el, (fp) => renderHorizon(fp));
  if (focusPeriod) el.querySelector(`.hz-add-input[data-period="${focusPeriod}"]`)?.focus();
}

export async function renderCalendar(focusPeriod) {
  if (!calMonth) { const n = new Date(); calMonth = { y: n.getFullYear(), m: n.getMonth() }; }
  const el = $('calendar');
  let life = [], years = [], months = [], days = [];
  try { [life, years, months, days] = await Promise.all(['life', 'years', 'months', 'days'].map((s) => api('GET', `/api/horizons?scale=${s}`))); } catch {  }
  const yKey = String(calMonth.y); const mKey = `${calMonth.y}-${pad2(calMonth.m + 1)}`;
  const byDay = {}; for (const g of days) (byDay[g.period] ||= []).push(g);
  const card = (title, scale, period, list) => `<div class="cal-hz">
      <div class="cal-hz-h">${esc(title)}</div>
      <div class="hz-goals">${list.map(goalRowHTML).join('')}
        <input class="hz-add-input" placeholder="${tr('Add…')}" data-scale="${scale}" data-period="${period}"></div>
    </div>`;
  const first = new Date(calMonth.y, calMonth.m, 1);
  const start = new Date(first); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const today = ymdLocal(new Date());
  let grid = '';
  for (let w = 0; w < 6; w++) {
    let row = '';
    const wd = new Date(start); wd.setDate(wd.getDate() + w * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(d.getDate() + w * 7 + i);
      const key = ymdLocal(d); const gl = byDay[key] || [];
      row += `<div class="cal-day${d.getMonth() === calMonth.m ? '' : ' off'}${key === today ? ' today' : ''}" data-day="${key}">
        <div class="cal-day-n">${d.getDate()}</div>
        <div class="cal-day-goals">${gl.map((g) => `<div class="cal-chip${g.done ? ' done' : ''}" data-id="${g.id}" title="${esc(g.text)}">${esc(g.text || '…')}</div>`).join('')}</div></div>`;
    }
    grid += `<div class="cal-row"><div class="cal-wk">W${isoWeek(wd)}</div>${row}</div>`;
  }
  el.innerHTML = `<div class="cal-wrap">
    <div class="cal-horizons">
      ${card(tr('Life'), 'life', 'life', life)}
      ${card(yKey, 'years', yKey, years.filter((g) => g.period === yKey))}
      ${card(MONTHS[calMonth.m], 'months', mKey, months.filter((g) => g.period === mKey))}
    </div>
    <div class="cal-head">
      <button class="cal-nav" data-nav="-1">‹</button>
      <span class="cal-title">${MONTHS[calMonth.m]} ${calMonth.y}</span>
      <button class="cal-nav" data-nav="1">›</button>
      <button class="cal-today" data-nav="0">${tr('Today')}</button>
    </div>
    <div class="cal-grid">
      <div class="cal-row cal-wdh"><div class="cal-wk"></div>${DOW.map((w) => `<div class="cal-wd">${tr(w)}</div>`).join('')}</div>
      ${grid}
    </div>
  </div>`;
  wireGoals(el, () => renderCalendar());
  el.querySelectorAll('.cal-nav').forEach((b) => { b.onclick = () => {
    const n = Number(b.dataset.nav);
    if (n === 0) { const t = new Date(); calMonth = { y: t.getFullYear(), m: t.getMonth() }; }
    else { let m = calMonth.m + n, y = calMonth.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } calMonth = { y, m }; }
    renderCalendar();
  }; });
  el.querySelectorAll('.cal-chip').forEach((ch) => { ch.onclick = async (e) => { e.stopPropagation(); const id = ch.dataset.id; await hzPatch(id, { done: !ch.classList.contains('done') }).catch(() => {}); renderCalendar(); }; });
  el.querySelectorAll('.cal-day').forEach((cell) => { cell.onclick = () => {
    styledPrompt(tr('Goal for the day'), { placeholder: tr('what to do'), okLabel: tr('Add'), onSubmit: async (text) => {
      if (text && text.trim()) { await hzAdd('days', cell.dataset.day, text.trim()).catch(() => {}); renderCalendar(); }
    } });
  }; });
  if (focusPeriod) el.querySelector(`.hz-add-input[data-period="${focusPeriod}"]`)?.focus();
}
