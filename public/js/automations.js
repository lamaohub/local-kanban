
import { $, AUTO, api, esc, ic, state, tr } from './core.js';
import { buildSelect } from './board.js';
import { keepFocus } from './now.js';
import { openDrawer } from './drawer.js';
import { startEffort } from './launch-rules.js';
import { checkWords } from './review.js';
import { getSetting, openSettingsModal } from './settings.js';
import { renderSidebar, selectProject, styledAlert } from './sidebar.js';
import { refusalLine } from './unsaved.js';

let auto = { on: false, rules: [] };
let skew = 0; // the server's clock minus ours: a guest's phone may run off the Mac's
/** The last view of the server: {on, rules}. */
export const automations = () => auto;
/** The armed rules (one per project at most). */
export const armedRules = () => (auto.on ? auto.rules.filter((r) => r.state === 'armed') : []);
const armedOf = (slug) => armedRules().find((r) => r.project === slug) || null;

/** Read the view from the server; quiet — the board works the same without it. */
export async function loadAutomations() {
  try { applyAutomations(await api('GET', '/api/automations', undefined, { quiet: true })); } catch { /* keep what was */ }
}
/** Take a view (the event's or an answer's) and draw what shows it. */
export function applyAutomations(v) {
  if (!v || !Array.isArray(v.rules)) return;
  const sig = (x) => JSON.stringify([x.on, x.rules.filter((r) => r.state === 'armed').length]);
  const sidebar = sig(v) !== sig(auto);
  auto = { on: Boolean(v.on), rules: v.rules };
  if (typeof v.now === 'number') skew = v.now - Date.now();
  if (sidebar) renderSidebar();
  if (state.slug === AUTO && $('automations')) paint();
  document.querySelectorAll('.auto-slot').forEach(fillSlot);
  tickSoon();
}

/* ── the countdown: one timer while something counts down ── */
let timer = null;
const left = (due) => Math.max(0, due - (Date.now() + skew));
const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickSoon() {
  const counting = armedRules().some((r) => r.due_at);
  if (counting && !timer) timer = setInterval(tick, 1000);
  if (!counting && timer) { clearInterval(timer); timer = null; }
  tick();
}
function tick() {
  document.querySelectorAll('[data-due]').forEach((el) => { el.textContent = mmss(left(Number(el.dataset.due))); });
}

/* ── words ── */
const keysOf = (r) => (r.keys || []).join(', ');
/** What an armed rule waits for, in the board's words. */
export function phaseLine(r) {
  if (r.phase === 'ready' && r.due_at) return `${tr('Check in')} <span class="auto-due" data-due="${r.due_at}">${mmss(left(r.due_at))}</span>`;
  const say = {
    idle: tr('Waits for Claude to take up tasks of the project'),
    working: `${tr('Claude is at work:')} ${esc(keysOf(r))}`,
    ready: tr('Claude has finished — the pause begins'),
  }[r.phase];
  if (say) return say;
  const held = {
    question: `${tr('Waits for you: a question of Claude in')} ${esc(keysOf(r))}`,
    ask: `${tr('Waits for you: Claude asks in')} ${esc(keysOf(r))}`,
    'sent-back': `${tr('Waits for you: back in To do —')} ${esc(keysOf(r))}`,
    limit: tr('Waits for the subscription limit to reset'),
    'check-open': `${tr('The project already has an open check')} ${esc(keysOf(r))}`,
    nothing: tr('Nothing in Review to check'),
    off: tr('Automations are switched off in Settings'),
  }[r.reason];
  return held || esc(r.reason || r.phase || '');
}
const phaseText = (r) => { const d = document.createElement('div'); d.innerHTML = phaseLine(r); return d.textContent; };
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const FAIL_WORDS = {
  'no-folder': 'the project has no folder on this computer',
  'no-tmux': 'tmux is not installed here',
  'no-claude': 'Claude Code is not installed here',
  'too-long': 'the prompt is too long for the board\'s terminal',
  'check-open': 'the project already has an open check',
  manual: 'a task done by hand cannot be given to Claude',
};
function endedLine(r) {
  const key = r.check_key ? `<button type="button" class="auto-key" data-key="${esc(r.check_key)}">${esc(r.check_key)}</button>` : '';
  if (r.state === 'fired') return `${tr('Check started')} ${key} · ${hm(r.ended_at)}`;
  if (r.state === 'covered') return `${tr('The check was started by hand:')} ${key} · ${hm(r.ended_at)}`;
  if (r.state === 'cancelled') return `${tr('Taken off')} · ${hm(r.ended_at)}${/^archived:/.test(r.error || '') ? `: ${tr('the project was archived')}` : ''}`;
  const reason = String(r.error || '').match(/^([a-z-]+): /)?.[1];
  const why = reason && FAIL_WORDS[reason] ? tr(FAIL_WORDS[reason]) : esc(r.error || '');
  return `${tr('Did not start')} · ${hm(r.ended_at)}: ${why}${key ? ` · ${tr('the check waits in To do:')} ${key}` : ''}`;
}

/* ── the section ── */
const projectName = (slug) => { const p = state.projects.find((x) => x.slug === slug); return p ? (p.name || p.slug) : slug; };
const ruleWhat = (r) => `${tr('When')} <b>${esc(r.project_name || projectName(r.project))}</b> ${tr('finishes, wait')} ${Math.round(r.delay_s / 60)} ${tr('min and check Review')}`;

function newRuleHTML() {
  return '<div class="panel auto-new">'
    + `<div class="auto-h">${ic('bolt', 14)} ${tr('New automation')}</div>`
    + '<div class="auto-sentence">'
    + `<span>${tr('When')}</span><div class="kbsel auto-proj" id="auto-proj"></div><span>${tr('finishes its work,')}</span>`
    + `<span>${tr('wait')}</span><input type="number" id="auto-min" class="auto-min" min="0" max="120" step="1" value="3" inputmode="numeric" aria-label="${esc(tr('minutes'))}"><span>${tr('min')}</span>`
    + `<span>${tr('and start a check of the tasks in Review')}</span></div>`
    + `<div class="muted auto-hint">${tr('Runs once: when every task Claude took in the project has reached Review and nothing waits for you. Like ▶ on the Review column — Claude inside the board, with the permissions and effort of Settings → Claude Code.')}</div>`
    + `<div class="auto-actions"><button type="button" class="btn-primary" id="auto-add">${tr('Add')}</button></div>`
    + '</div>';
}
function armedHTML(r) {
  return `<div class="panel auto-rule" data-id="${r.id}">`
    + `<div class="auto-rule-main"><div class="auto-what">${ruleWhat(r)}</div>`
    + `<div class="auto-phase${r.phase === 'ready' ? ' auto-ready' : ''}">${phaseLine(r)}</div></div>`
    + `<button type="button" class="btn-ghost auto-drop" data-id="${r.id}">${tr('Take off')}</button></div>`;
}
function endedHTML(r) {
  return `<div class="auto-past auto-${esc(r.state)}" data-id="${r.id}">`
    + `<div class="auto-rule-main"><div class="auto-what">${ruleWhat(r)}</div><div class="auto-phase">${endedLine(r)}</div></div>`
    + `<button type="button" class="btn-icon auto-forget" data-id="${r.id}" title="${esc(tr('Remove from the list'))}" aria-label="${esc(tr('Remove from the list'))}">✕</button></div>`;
}

let picked = '';
let freeSig = '';
/* The form is drawn once per opening and kept: the section repaints on every event of the board (it is a special view,
   and the 5 s look of the server sends its own), and a form drawn anew took the focus out of the minutes field and
   closed the open list of projects under the hand (review). Only the list of rules is drawn again. */
function paint() {
  const box = $('automations');
  if (!auto.on) {
    box.dataset.mode = 'off';
    box.innerHTML = `<div class="now-wrap"><div class="panel now-empty"><div class="now-empty-h">${tr('Automations are switched off')}</div>`
      + `<div class="muted">${tr('Switch them on in Settings → Claude Code.')}</div>`
      + `<div class="auto-actions"><button type="button" class="btn-ghost" id="auto-settings">${tr('Open Settings')}</button></div></div></div>`;
    $('auto-settings').onclick = () => openSettingsModal('claude');
    return;
  }
  if (box.dataset.mode !== 'on' || !$('auto-list')) {
    box.dataset.mode = 'on';
    box.innerHTML = `<div class="now-wrap">${newRuleHTML()}<div id="auto-list" class="auto-list"></div></div>`;
    freeSig = '';
    $('auto-add').onclick = () => addRule($('auto-add'));
  }
  const armed = auto.rules.filter((r) => r.state === 'armed');
  const past = auto.rules.filter((r) => r.state !== 'armed');
  const free = state.projects.filter((p) => !p.archived && !armed.some((r) => r.project === p.slug));
  const sig = JSON.stringify(free.map((p) => [p.slug, p.name]));
  if (sig !== freeSig && !$('auto-proj').classList.contains('open')) {
    freeSig = sig;
    if (!free.some((p) => p.slug === picked)) picked = free.find((p) => p.slug === state.lastProject)?.slug || free[0]?.slug || '';
    buildSelect($('auto-proj'), {
      value: picked, placeholder: tr('no project is free'), search: free.length > 8,
      options: free.map((p) => ({ value: p.slug, label: p.name || p.slug })),
      onChange: (v) => { picked = v; },
    });
    $('auto-add').disabled = !free.length;
  }
  const list = $('auto-list');
  keepFocus(list, () => {
    list.innerHTML = (armed.length ? `<div class="auto-sec-h">${tr('Waiting')}</div>${armed.map(armedHTML).join('')}` : '')
      + (past.length ? `<div class="auto-sec-h">${tr('History')}</div><div class="panel auto-past-list">${past.map(endedHTML).join('')}</div>` : '');
  });
  list.querySelectorAll('.auto-drop, .auto-forget').forEach((b) => { b.onclick = () => dropRule(b.dataset.id, b); });
  list.querySelectorAll('.auto-key').forEach((b) => { b.onclick = () => openDrawer(b.dataset.key); });
}

async function addRule(btn) {
  const min = Number($('auto-min').value);
  if (!picked) return;
  if (!Number.isInteger(min) || min < 0 || min > 120) { styledAlert(tr('The pause is whole minutes, from 0 to 120.')); return; }
  btn.disabled = true;
  try {
    const v = await api('POST', '/api/automations', {
      project: picked, delay_min: min, words: checkWords(),
      launch: { permission: getSetting('permission'), effort: startEffort(true, getSetting('effort'), getSetting('effortCheck')) || undefined },
    }, { quiet: true });
    btn.disabled = false;
    applyAutomations(v);
  } catch (e) {
    btn.disabled = false;
    styledAlert(refusalLine('Could not add the automation', e, tr));
  }
}
async function dropRule(id, btn) {
  btn.disabled = true;
  try { applyAutomations(await api('DELETE', `/api/automations/${Number(id)}`, undefined, { quiet: true })); } catch (e) {
    btn.disabled = false;
    styledAlert(refusalLine('Could not take the automation off', e, tr));
  }
}

/** Draw the section from a fresh answer of the server. */
export async function renderAutomations() {
  if (auto.rules.length || auto.on) paint(); // what is known draws at once; the answer paints again (applyAutomations)
  await loadAutomations();
}

/* ── elsewhere: next to ▶ of Review and over Claude now ── */
/** A slot that shows the armed rule of `slug` (the board of a project): a chip with the countdown; empty without one. */
export function autoSlot(slug) {
  const el = document.createElement('span');
  el.className = 'auto-slot';
  el.dataset.project = slug;
  fillSlot(el);
  return el;
}
function fillSlot(el) {
  if (el.classList.contains('auto-strip')) { fillStrip(el); return; }
  const r = armedOf(el.dataset.project || '');
  if (!r) { el.innerHTML = ''; el.onclick = null; return; }
  const counting = r.phase === 'ready' && r.due_at;
  // a column of 230px holds its name, the count, ⇅ and ▶: the chip is the bolt alone while it waits, the time alone once
  // it counts down — with the bolt and a word it ran 10px past the column
  const say = `${tr('Automation: a check of Review once Claude has finished')} — ${phaseText(r)}`;
  el.innerHTML = `<button type="button" class="auto-chip${counting ? ' on' : ''}" title="${esc(say)}" aria-label="${esc(say)}">`
    + `${counting ? `<span data-due="${r.due_at}">${mmss(left(r.due_at))}</span>` : ic('bolt', 12)}</button>`;
  el.querySelector('button').onclick = (e) => { e.stopPropagation(); selectProject(AUTO); };
}
/** A slot over Claude now: a line per armed rule (filled by fillAutoSlots once it is in the page). */
export const autoStripHTML = () => '<div class="auto-slot auto-strip"></div>';
function fillStrip(el) {
  el.innerHTML = armedRules().map((r) => `<div class="auto-strip-row">${ic('bolt', 12)}<b>${esc(r.project_name || projectName(r.project))}</b><span class="auto-strip-say">${phaseLine(r)}</span>`
    + `<button type="button" class="btn-ghost auto-strip-go">${tr('Automations')}</button></div>`).join('');
  el.querySelectorAll('.auto-strip-go').forEach((b) => { b.onclick = () => selectProject(AUTO); });
}
/** Fill the slots inside `box` (a section that draws its HTML as a string). */
export function fillAutoSlots(box) { box.querySelectorAll('.auto-slot').forEach(fillSlot); }
