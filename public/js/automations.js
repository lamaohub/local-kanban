
import { $, AUTO, api, esc, ic, state, tr } from './core.js';
import { buildSelect } from './board.js';
import { keepFocus } from './now.js';
import { openDrawer } from './drawer.js';
import { startEffort } from './launch-rules.js';
import { checkWords } from './review.js';
import { getSetting, openSettingsModal } from './settings.js';
import { renderSidebar, selectProject, styledAlert } from './sidebar.js';
import { refusalLine } from './unsaved.js';
import { failWord } from './review-rules.js';

const CHECK_KIND = 'finished-check';
const SCHEDULED = new Set(['schedule-check', 'schedule-groom']);
let auto = { on: false, rules: [] };
let skew = 0; // the server's clock minus ours: a guest's phone may run off the Mac's
/** The last view of the server: {on, rules}. */
export const automations = () => auto;
export const armedRules = () => (auto.on ? auto.rules.filter((r) => r.state === 'armed') : []);
const armedOf = (slug) => armedRules().find((r) => r.project === slug && r.kind === CHECK_KIND) || null; // what ▶ of Review waits for

/** Read the view from the server; quiet — the board works the same without it. */
export async function loadAutomations() {
  try { applyAutomations(await api('GET', '/api/automations', undefined, { quiet: true })); } catch { /* keep what was */ }
}
/** Take a view (the event's or an answer's) and draw what shows it. */
export function applyAutomations(v) {
  if (!v || !Array.isArray(v.rules)) return;
  const sig = (x) => JSON.stringify([x.on, x.rules.filter((r) => r.state === 'armed').length]);
  const sidebar = sig(v) !== sig(auto);
  auto = { on: Boolean(v.on), rules: v.rules, extras: v.extras || {} };
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
  if (r.phase === 'ready' && r.due_at) return `${tr(r.kind === 'todo-queue' ? 'Next batch in' : 'Check in')} <span class="auto-due" data-due="${r.due_at}">${mmss(left(r.due_at))}</span>`;
  const say = {
    idle: tr('Waits for Claude to take up tasks of the project'),
    working: `${tr('Claude is at work:')} ${esc(keysOf(r))}`,
    ready: tr('Claude has finished — the pause begins'),
    planned: `${tr('Next run:')} ${esc(r.plan?.at || '')}`,
  }[r.phase];
  if (say) return say;
  const held = {
    'at-work': `${tr('Claude is at work:')} ${esc(keysOf(r))}`,
    question: `${tr('Waits for you: a question of Claude in')} ${esc(keysOf(r))}`,
    ask: `${tr('Waits for you: Claude asks in')} ${esc(keysOf(r))}`,
    'sent-back': `${tr('Waits for you: back in To do —')} ${esc(keysOf(r))}`,
    limit: tr('Waits for the subscription limit to reset'),
    'check-open': `${tr('The project already has an open check')} ${esc(keysOf(r))}`,
    'day-cap': `${tr('The checks of the day are used up:')} ${r.fires_max}`,
    busy: tr('Waits for a place: enough checks run on the board now'),
    'limit-high': tr('Waits: over 80% of the subscription limit is used'),
    'queue-empty': tr('Nothing to take in To do'),
    unfinished: `${tr('Waits: the work in the project was cut off —')} ${esc(keysOf(r))}`,
    nothing: tr('Nothing in Review to check'),
    off: tr('Automations are switched off in Settings'),
  }[r.reason];
  return held || esc(r.reason || r.phase || '');
}
const phaseText = (r) => { const d = document.createElement('div'); d.innerHTML = phaseLine(r); return d.textContent; };
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const failWhy = (r) => { const word = failWord(r.error); return word ? tr(word) : esc(r.error || ''); };
function endedLine(r) {
  const key = r.check_key ? `<button type="button" class="auto-key" data-key="${esc(r.check_key)}">${esc(r.check_key)}</button>` : '';
  if (r.state === 'fired') return `${tr('Check started')} ${key} · ${hm(r.ended_at)}`;
  if (r.state === 'covered') return `${tr('The check was started by hand:')} ${key} · ${hm(r.ended_at)}`;
  if (r.state === 'cancelled') return `${tr('Taken off')} · ${hm(r.ended_at)}${/^archived:/.test(r.error || '') ? `: ${tr('the project was archived')}` : ''}`;
  return `${tr('Did not start')} · ${hm(r.ended_at)}: ${failWhy(r)}${key ? ` · ${tr('the check waits in To do:')} ${key}` : ''}`;
}

/* ── the section ── */
const projectName = (slug) => { const p = state.projects.find((x) => x.slug === slug); return p ? (p.name || p.slug) : slug; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const whenWords = (plan) => `${plan?.day === null || plan?.day === undefined ? tr('Every day') : tr(DAYS[plan.day])}, ${esc(plan?.at || '')}`;
const ruleWhat = (r) => (r.kind === 'todo-queue' ? `${tr('When')} <b>${esc(r.project_name || projectName(r.project))}</b> ${tr('finishes, wait')} ${Math.round(r.delay_s / 60)} ${tr('min and start the next batch of To do')}`
  : r.kind === 'schedule-check' ? `<b>${esc(r.project_name || projectName(r.project))}</b>: ${tr('a check of Review')} · ${whenWords(r.plan)}`
    : r.kind === 'schedule-groom' ? `<b>${esc(r.project_name || projectName(r.project))}</b>: ${tr('the grooming of the backlog')} · ${whenWords(r.plan)}` : checkWhat(r));
const checkWhat = (r) => `${tr('When')} <b>${esc(r.project_name || projectName(r.project))}</b> ${tr('finishes, wait')} ${Math.round(r.delay_s / 60)} ${tr(r.repeat ? 'min and check Review, every time' : 'min and check Review')}${r.fix ? `, ${tr('fixing what comes back')}` : ''}`;

const KIND_NAMES = [
  [CHECK_KIND, 'A check once Claude has finished'], ['todo-queue', 'The next batch of To do'],
  ['schedule-check', 'A check of Review on a schedule'], ['schedule-groom', 'The grooming of the backlog on a schedule'],
];
const KIND_HINTS = {
  [CHECK_KIND]: 'Starts when every task Claude took in the project has reached Review and nothing waits for you. Like ▶ on the Review column — Claude inside the board, with the permissions and effort of Settings → Claude Code.',
  'todo-queue': 'At most 5 tasks by priority, without ask and noclaude; it does not start while over 80% of the 5-hour or the weekly limit is used, nor over a question of Claude.',
  'schedule-check': 'If the computer sleeps at that time the run is skipped until the next one. It does not start over work going on in the project.',
  'schedule-groom': 'Claude prepares the backlog and moves no tasks. If the computer sleeps at that time the run is skipped until the next one.',
};
let formKind = CHECK_KIND;
let formDay = 'every';
function newRuleHTML() {
  return '<div class="panel auto-new">'
    + `<div class="auto-h">${ic('bolt', 14)} ${tr('New automation')}</div>`
    + `<div class="auto-sentence"><div class="kbsel auto-kind" id="auto-kind"></div></div>`
    + `<div class="auto-sentence" data-for="wait"><span>${tr('When the project finishes its work,')}</span>`
    + `<span>${tr('wait')}</span><input type="number" id="auto-min" class="auto-min" min="0" max="120" step="1" value="3" inputmode="numeric" aria-label="${esc(tr('minutes'))}"><span>${tr('min')}</span>`
    + `<span id="auto-then"></span></div>`
    + `<div class="auto-sentence" data-for="plan"><span>${tr('At')}</span><input type="time" id="auto-at" class="auto-min auto-at" value="03:00" aria-label="${esc(tr('Time'))}"><div class="kbsel auto-day" id="auto-day"></div></div>`
    + `<div class="auto-picks-h"><span>${tr('Projects')}</span><button type="button" class="auto-all" id="auto-all"></button></div>`
    + '<div class="auto-picks" id="auto-picks"></div>'
    + `<label class="set-row auto-repeat" data-for="check"><span class="set-lab">${tr('Repeat')}<small>${tr('after a check the rule waits for the next batch, until you take it off')}</small></span><input type="checkbox" class="set-toggle" id="auto-repeat" checked></label>`
    + `<label class="set-row auto-repeat" data-for="check" id="auto-fix-row"><span class="set-lab">${tr('Fix what the check returns')}<small>${tr('the board starts a returned task in a new session and the check comes after it, at most 2 rounds; then the task waits for you')}</small></span><input type="checkbox" class="set-toggle" id="auto-fix"></label>`
    + '<div class="muted auto-hint" id="auto-hint"></div>'
    + `<div class="auto-actions"><button type="button" class="btn-primary" id="auto-add">${tr('Add')}</button></div>`
    + '</div>';
}
/** The form for the kind of rule chosen. */
function paintKind() {
  const shows = { wait: !SCHEDULED.has(formKind), plan: SCHEDULED.has(formKind), check: formKind === CHECK_KIND };
  document.querySelectorAll('.auto-new [data-for]').forEach((el) => { el.classList.toggle('hidden', !shows[el.dataset.for]); });
  $('auto-then').textContent = tr(formKind === CHECK_KIND ? 'and start a check of the tasks in Review' : 'and start the next batch of To do');
  $('auto-hint').textContent = tr(KIND_HINTS[formKind]);
  if (formKind === CHECK_KIND) $('auto-fix-row').classList.toggle('hidden', !$('auto-repeat').checked);
}
function wireForm() {
  buildSelect($('auto-kind'), { value: formKind, options: KIND_NAMES.map(([value, label]) => ({ value, label: tr(label) })),
    onChange: (v) => { formKind = v; freeSig = ''; paintKind(); paint(); } });
  buildSelect($('auto-day'), { value: formDay, options: [{ value: 'every', label: tr('Every day') }, ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: tr(DAYS[d]) }))],
    onChange: (v) => { formDay = v; } });
  paintKind();
}
const EXTRAS = [
  ['resume', 'Go on with interrupted work', 'once the limit has reset or the Mac is up: all sessions, at most 3 times in a row, one a minute; never one that waits for you'],
  ['health', 'Watch the size of CLAUDE.md', 'a file past the norm of Health gets a task in the backlog of its project, once a day; you start it yourself'],
];
function extrasHTML() {
  return `<div class="panel auto-extras"><div class="auto-h">${ic('bolt', 14)} ${tr('By itself')}</div>`
    + EXTRAS.map(([k, name, hint]) => `<label class="set-row auto-repeat"><span class="set-lab">${tr(name)}<small>${tr(hint)}</small></span><input type="checkbox" class="set-toggle" data-extra="${k}"></label>`).join('')
    + '</div>';
}
function paintExtras() {
  document.querySelectorAll('[data-extra]').forEach((b) => { if (!b.disabled) b.checked = Boolean(auto.extras?.[b.dataset.extra]); });
}
function wireExtras() {
  document.querySelectorAll('[data-extra]').forEach((b) => {
    b.onchange = async () => {
      b.disabled = true;
      const launch = { permission: getSetting('permission'), effort: startEffort(false, getSetting('effort'), getSetting('effortCheck')) || undefined };
      try { const v = await api('PUT', '/api/automations/extras', { [b.dataset.extra]: b.checked, launch }, { quiet: true }); b.disabled = false; applyAutomations(v); } catch (e) {
        b.disabled = false;
        b.checked = !b.checked;
        styledAlert(refusalLine('Could not change the automation', e, tr));
      }
    };
  });
}

function repeatLine(r) {
  if (!r.repeat || !(r.fires_n || r.error)) return '';
  const key = r.check_key ? ` · <button type="button" class="auto-key" data-key="${esc(r.check_key)}">${esc(r.check_key)}</button>` : '';
  if (r.error) return `<div class="auto-phase">${tr('Did not start')}: ${failWhy(r)}${r.check_key && r.check_status === 'todo' ? ` · ${tr('the check waits in To do:')}${key.slice(2)}` : ''}</div>`;
  return `<div class="auto-phase">${tr('Checks in the last day:')} ${r.fires_n} / ${r.fires_max}${key}</div>`;
}
function armedHTML(r) {
  return `<div class="panel auto-rule" data-id="${r.id}">`
    + `<div class="auto-rule-main"><div class="auto-what">${ruleWhat(r)}</div>`
    + `<div class="auto-phase${r.phase === 'ready' ? ' auto-ready' : ''}">${phaseLine(r)}</div>${repeatLine(r)}</div>`
    + `<button type="button" class="btn-ghost auto-drop" data-id="${r.id}">${tr('Take off')}</button></div>`;
}
function endedHTML(r) {
  return `<div class="auto-past auto-${esc(r.state)}" data-id="${r.id}">`
    + `<div class="auto-rule-main"><div class="auto-what">${ruleWhat(r)}</div><div class="auto-phase">${endedLine(r)}</div></div>`
    + `<button type="button" class="btn-icon auto-forget" data-id="${r.id}" title="${esc(tr('Remove from the list'))}" aria-label="${esc(tr('Remove from the list'))}">✕</button></div>`;
}

const picked = new Set();
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
    box.innerHTML = `<div class="now-wrap">${newRuleHTML()}${extrasHTML()}<div id="auto-list" class="auto-list"></div></div>`;
    wireExtras();
    freeSig = '';
    $('auto-add').onclick = () => addRule($('auto-add'));
    $('auto-repeat').onchange = paintKind;
    wireForm();
    $('auto-all').onclick = () => {
      const boxes = [...document.querySelectorAll('#auto-picks input')];
      const all = boxes.every((b) => b.checked);
      for (const b of boxes) { b.checked = !all; if (all) picked.delete(b.value); else picked.add(b.value); }
      paintPicks();
    };
  }
  paintExtras();
  const armed = auto.rules.filter((r) => r.state === 'armed');
  const past = auto.rules.filter((r) => r.state !== 'armed');
  const free = state.projects.filter((p) => !p.archived && !armed.some((r) => r.project === p.slug && r.kind === formKind));
  const sig = JSON.stringify(free.map((p) => [p.slug, p.name]));
  if (sig !== freeSig) {
    freeSig = sig;
    for (const slug of picked) if (!free.some((p) => p.slug === slug)) picked.delete(slug);
    if (!picked.size) { const first = free.find((p) => p.slug === state.lastProject) || free[0]; if (first) picked.add(first.slug); }
    $('auto-picks').innerHTML = free.map((p) => `<label class="auto-pick"><input type="checkbox" value="${esc(p.slug)}"${picked.has(p.slug) ? ' checked' : ''}><span>${esc(p.name || p.slug)}</span></label>`).join('')
      || `<span class="muted">${tr('no project is free')}</span>`;
    $('auto-picks').querySelectorAll('input').forEach((b) => { b.onchange = () => { if (b.checked) picked.add(b.value); else picked.delete(b.value); paintPicks(); }; });
    paintPicks();
  }
  const list = $('auto-list');
  keepFocus(list, () => {
    list.innerHTML = (armed.length ? `<div class="auto-sec-h">${tr('Waiting')}</div>${armed.map(armedHTML).join('')}` : '')
      + (past.length ? `<div class="auto-sec-h">${tr('History')}</div><div class="panel auto-past-list">${past.map(endedHTML).join('')}</div>` : '');
  });
  list.querySelectorAll('.auto-drop, .auto-forget').forEach((b) => { b.onclick = () => dropRule(b.dataset.id, b); });
  list.querySelectorAll('.auto-key').forEach((b) => { b.onclick = () => openDrawer(b.dataset.key); });
}

function paintPicks() {
  const boxes = [...document.querySelectorAll('#auto-picks input')];
  $('auto-add').disabled = !picked.size;
  $('auto-all').textContent = tr(boxes.length && boxes.every((b) => b.checked) ? 'Clear' : 'All projects');
  $('auto-all').hidden = boxes.length < 2;
}

const BACK_WORDS = 'Each task that does not pass goes back to work by itself: write what is wrong with kb note <KEY>, then kb mv <KEY> todo.';
async function addRule(btn) {
  const min = Number($('auto-min').value);
  if (!picked.size) return;
  if (!SCHEDULED.has(formKind) && (!Number.isInteger(min) || min < 0 || min > 120)) { styledAlert(tr('The pause is whole minutes, from 0 to 120.')); return; }
  btn.disabled = true;
  const check = formKind === CHECK_KIND;
  const repeat = check && $('auto-repeat').checked;
  const fix = repeat && $('auto-fix').checked;
  const plan = { at: $('auto-at').value, day: formDay === 'every' ? null : Number(formDay) };
  const launch = { permission: getSetting('permission'), effort: startEffort(formKind === 'schedule-check' || check, getSetting('effort'), getSetting('effortCheck')) || undefined };
  const wordsFor = (project) => {
    if (formKind === 'todo-queue') { const w = checkWords(); return { run: w.run, doTask: w.doTask }; }
    if (formKind === 'schedule-groom') return { run: checkWords().run, groom: `${tr('Groom the backlog of')} ${project} ${tr('(grooming mode):')}` };
    return { ...checkWords(), ...(fix ? { back: tr(BACK_WORDS) } : {}) };
  };
  const refused = [];
  let last = null;
  for (const project of [...picked]) {
    try {
      last = await api('POST', '/api/automations', {
        project, kind: formKind, ...(SCHEDULED.has(formKind) ? { plan } : { delay_min: min }), ...(check ? { repeat, fix } : {}), words: wordsFor(project), launch,
      }, { quiet: true });
    } catch (e) { refused.push(`${projectName(project)}: ${refusalLine('Could not add the automation', e, tr)}`); }
  }
  btn.disabled = !picked.size;
  if (last) applyAutomations(last);
  if (refused.length) styledAlert(refused.join('\n'));
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
