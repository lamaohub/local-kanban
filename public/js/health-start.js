import { $, HEALTH, api, esc, state, tr } from './core.js';
import { usageFmt } from './sse.js';
import { tokensText } from './usage-rules.js';
import { startParts } from './health-rules.js';

let seq = 0;
let last = null;
let lastAt = 0;
const FRESH_MS = 60_000; // the board repaints Health on its events — the walk is asked again at most once a minute
const k = (n) => (Number.isFinite(n) ? tokensText(n, usageFmt) : '—');

function rowHTML(p, norm) {
  const parts = startParts(p.parts, { tr }).map((x) => `<span class="hs-part"><span class="muted">${esc(x.label)}</span> ${esc(k(x.chars))}</span>`).join('');
  return `<div class="hs-row${p.over ? ' hs-over' : ''}">`
    + `<div class="hs-head"><span class="hs-name">${esc(p.name)}</span>`
    + `<span class="hs-first${p.over ? ' hl-heavy' : ''}" title="${esc(`${tr('The norm:')} ${k(norm)}`)}">${esc(k(p.first))} ${esc(tr('at the start'))}</span>`
    + `<span class="hs-skill muted">${esc(k(p.with_skill))} ${esc(tr('with the kanban skill'))}</span>`
    + `<span class="hs-n muted">${esc(String(p.sessions))} ${esc(usageFmt.plural(p.sessions, 'session', 'sessions'))}</span></div>`
    + `<div class="hs-parts">${parts}</div></div>`;
}

/** `still()` — whether this tab is still the one in sight: the walk takes seconds, and the person may switch meanwhile. */
export async function renderStart(tabs, still = () => true) {
  const my = ++seq;
  const box = $('health');
  const paint = (d) => {
    box.innerHTML = `<div class="now-wrap hl-wrap" data-hs>${tabs}`
      + `<div class="hl-sum muted">${esc(tr('What a session of each project carries before its first step and rereads on every request — the median of its sessions of the last'))} ${esc(String(d.days))} ${esc(usageFmt.plural(d.days, 'day', 'days'))}. `
      + `${esc(tr('Tokens as the model counted them; the parts — in characters. The norm:'))} ${esc(k(d.norm))}.</div>`
      + (d.projects.length ? d.projects.map((p) => rowHTML(p, d.norm)).join('') : `<div class="muted">${esc(tr('No sessions of the board in these days.'))}</div>`)
      + '</div>';
  };
  if (last && Date.now() - lastAt < FRESH_MS) { if (!box.querySelector('[data-hs]')) paint(last); return; }
  if (last) paint(last);
  else box.innerHTML = `<div class="now-wrap hl-wrap">${tabs}<div class="muted">${esc(tr('Reading the transcripts…'))}</div></div>`;
  let d;
  try { d = await api('GET', '/api/health/start', undefined, { quiet: true }); } catch {
    if (my === seq && state.slug === HEALTH && still() && !last) box.innerHTML = `<div class="now-wrap hl-wrap">${tabs}<div class="muted">${esc(tr('Could not read the transcripts.'))}</div></div>`;
    return;
  }
  last = d;
  lastAt = Date.now();
  if (my !== seq || state.slug !== HEALTH || !still()) return;
  paint(d);
}
export const stopStart = () => { seq += 1; };
