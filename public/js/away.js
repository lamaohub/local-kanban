import { api, esc, tr } from './core.js';
import { automations, loadAutomations } from './automations.js';
import { openDrawer } from './drawer.js';
import { plural } from './settings.js';
import { overlayLayer } from './sidebar.js';
import { localStore } from './store.js';
import { awayDue, hasNews } from './away-rules.js';

const SEEN_KEY = 'kb.ui.lastSeen';
const SEEN_EVERY_MS = 60_000;
const seenAt = () => { try { return Number(localStore.getItem(SEEN_KEY)); } catch { return 0; } };
const noteSeen = () => { try { localStore.setItem(SEEN_KEY, String(Date.now())); } catch { /* not kept */ } };

const SECTIONS = [['handed', 'Handed in'], ['accepted', 'Accepted'], ['returned', 'Returned'], ['stuck', 'Stuck']];
function sectionHTML(k, name, s) {
  if (!s?.n) return '';
  const rows = s.tasks.map((t) => `<button type="button" class="away-row" data-key="${esc(t.key)}"><span class="away-key">${esc(t.key)}</span><span class="away-title">${esc(t.title)}</span><span class="away-proj">${esc(t.project)}</span></button>`).join('');
  const more = s.n - s.tasks.length;
  return `<div class="away-sec"><div class="away-h">${esc(tr(name))}: ${s.n}</div>${rows}${more > 0 ? `<div class="muted away-more">${tr('and more:')} ${more} ${esc(plural(more, 'task', 'tasks'))}</div>` : ''}</div>`;
}
function showSummary(s) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal away-box" role="dialog" aria-label="${esc(tr('While you were away'))}"><div class="modal-title">${esc(tr('While you were away'))}</div>`
    + `<div class="away-body">${SECTIONS.map(([k, name]) => sectionHTML(k, name, s[k])).join('')}</div>`
    + `<div class="modal-actions"><button type="button" class="btn-primary modal-ok">${esc(tr('Got it'))}</button></div></div>`;
  const close = overlayLayer(overlay);
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-ok').onclick = close;
  overlay.querySelectorAll('.away-row').forEach((b) => { b.onclick = () => { close(); openDrawer(b.dataset.key); }; });
  overlay.querySelector('.modal-ok').focus();
}

let looking = false;
async function look() {
  if (looking || document.hidden) return;
  const last = seenAt();
  if (Date.now() - last < SEEN_EVERY_MS) return;
  looking = true;
  noteSeen();
  try {
    if (!awayDue(last, Date.now())) return;
    await loadAutomations();
    if (!automations().on) return;
    const s = await api('GET', `/api/automations/summary?since=${Math.round(last)}`, undefined, { quiet: true });
    if (hasNews(s)) showSummary(s);
  } catch { try { localStore.setItem(SEEN_KEY, String(last)); } catch { /* not kept */ } /* asked again at the next touch */ } finally { looking = false; }
}
/** On start, on a return to the tab and on the person's first touch: a tab left on the screen overnight is no one there, so
    the moment seen is the person's, not the page's. */
export function startAway() {
  look();
  document.addEventListener('visibilitychange', look);
  for (const e of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(e, look, { passive: true, capture: true });
}
