import { $, api, esc, tr } from './core.js';
import { SHORT_MONTHS } from './sse.js';
import { limitsNone, limitsShown, limitsView } from './limits-rules.js';
import { getSetting, openSettingsModal } from './settings.js';

let snap = null;
let link = null;
let seq = 0; // live updates so far: a reading fetched while a newer one came over the event stream is dropped

const NAMES = { five_hour: '5 hours', seven_day: 'Week', spend_limit: 'Spend limit' };

// 24 hours whatever the browser's locale (a Mac set to English prints "05:57 PM"); today needs no date
function clock(ms) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${hm}`;
}

export async function loadLimits() {
  const from = seq;
  try {
    const got = await api('GET', '/api/limits', undefined, { quiet: true });
    link = got?.link ?? null;
    if (seq === from) snap = got;
  } catch { /* keep the last one */ }
  renderLimits();
}

export function applyLimits(data) {
  seq++;
  snap = data;
  if (data && 'link' in data) link = data.link;
  renderLimits();
}

export function renderLimits() {
  const el = $('limits');
  if (!el) return;
  // back on shows the current ones at once
  if (getSetting('showLimits') === false) { el.hidden = true; return; }
  const v = limitsView(snap, Date.now());
  if (!limitsShown(v.rows, link)) { el.hidden = true; return; }
  const head = `<div class="lim-head"><span>${esc(tr('Claude limits'))}</span>`
    + (v.at ? `<span class="lim-at" title="${esc(tr('Received from the status line of Claude Code in the terminal'))}">${esc(clock(v.at))}</span>` : '')
    + '</div>';
  const none = limitsNone();
  el.innerHTML = head + (v.rows.length
    ? v.rows.map((r) => `<div class="lim-row" title="${esc(`${tr('resets')} ${clock(r.resetsAt)}`)}">`
      + `<span class="lim-name">${esc(tr(NAMES[r.kind]))}</span>`
      + `<span class="lim-bar"><span style="width:${r.bar}%"></span></span>`
      + `<span class="lim-pct">${r.used}%</span></div>`).join('')
    : `<button type="button" class="lim-none" title="${esc(`${tr(none.title)} ${tr('The footer can be switched off in Settings → Claude Code.')}`)}">${esc(tr(none.text))}</button>`);
  el.querySelector('.lim-none')?.addEventListener('click', () => openSettingsModal('claude'));
  el.hidden = false;
}
