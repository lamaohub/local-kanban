
import { $, REVIEW, api, esc, ic, onApiWarning, state, tr } from './core.js';
import { openDrawer, openTerminalOf } from './drawer.js';
import { keepFocus, projectLinks, titleOf, wireProjectLinks, wireRows } from './now.js';
import { CHECK_LABEL, LIVE_CHECK, checkDescription, checkState, checkingFirst, holdsCheck, reviewGroups, sidebarOrder, warningLine } from './review-rules.js';
import { plural } from './settings.js';
import { styledAlert } from './sidebar.js';
import { launchInClaude, relTime, taskPromptText } from './sse.js';
import { refusalLine } from './unsaved.js';

// a group move of several reports says it once, not a window per card
let warnedAt = { line: '', at: 0 };
onApiWarning((w) => {
  const line = warningLine(w, tr);
  if (!line || (line === warnedAt.line && Date.now() - warnedAt.at < 3000)) return;
  warnedAt = { line, at: Date.now() };
  styledAlert(line);
});

// The check task's title: the owner's own words for what a check is. A check is told by its label, not by this.
const CHECK_TITLE = 'Check the tasks in Review with different tests and simulate failures, then move them to Done';
let last = null; // the last groups — for the button that starts a check

const CHECK_SAYS = {
  checking: ['Claude is checking', 'live-busy'],
  answer: ['Claude is waiting for an answer', 'live-wait'],
  waiting: ['The check is waiting to start', ''],
  closed: ['session closed', 'live-gone'], // its Claude is gone, the check is left in work — the card's words for it
  unsent: ['The check is waiting to start in the Claude app', 'live-wait'],
};
const stateOf = (g) => (g.running ? checkState(g.running, g.terminal, state.live?.[g.running.id]?.claude) : null);
function actionHTML(g) {
  if (g.running) {
    const st = stateOf(g);
    const [says, dot] = CHECK_SAYS[st];
    const what = tr(says);
    const title = st === 'answer' ? tr('Open the terminal of the check — Claude asks something there') : tr('Open the card of the check');
    // the words go when the window is too narrow for them (style.css): the dot and the key stay, the label is in aria-label
    return `<button class="btn-ghost rv-open" type="button" data-key="${esc(g.running.key)}"${st === 'answer' ? ' data-terminal="1"' : ''} title="${esc(title)}" aria-label="${esc(`${what} · ${g.running.key}`)}">`
      + `${dot ? `<span class="card-live ${dot}"><span class="live-dot"></span></span>` : ''}<span class="rv-label">${what}\u00a0·</span><span class="rv-key">${esc(g.running.key)}</span></button>`;
  }
  const label = tr('Check in Claude');
  // is not `disabled` — a press says which tasks hold it (Safari shows no tooltip on a disabled button, and the owner saw
  // only a grey ▶ with no word why)
  if (g.working?.length) {
    const why = heldWhy(g.working);
    return `<button class="btn-primary rv-go" type="button" aria-disabled="true" data-project="${esc(g.project)}" title="${esc(why)}" aria-label="${esc(why)}">`
      + `${ic('play', 12)}<span class="rv-label">${tr('In work')}: ${g.working.length}</span></button>`;
  }
  return `<button class="btn-primary rv-go" type="button" data-project="${esc(g.project)}" title="${esc(label)}" aria-label="${esc(label)}">`
    + `${ic('play', 12)}<span class="rv-label">${label}</span></button>`;
}

function groupHTML(g) {
  const rows = g.tasks.map((t) => `<div class="now-row" data-key="${esc(t.key)}" tabindex="0" role="button">`
    + '<span class="now-mk"><span class="dot s-review"></span></span>'
    + `<span class="now-main"><span class="now-t"><span class="now-key">${esc(t.key)}</span><span class="now-title">${titleOf(t)}</span></span></span>`
    + `<span class="rv-when">${esc(relTime(t.updated_at))}</span></div>`).join('');
  return `<div class="panel now-run rv-group${LIVE_CHECK.has(stateOf(g)) ? ' rv-live' : ''}">`
    + `<div class="now-run-h"><span class="now-who"><span class="now-proj">${projectLinks([{ project: g.project, project_name: g.name }])}</span>`
    + `<span class="now-since">${g.tasks.length} ${plural(g.tasks.length, 'task', 'tasks')}</span></span>${actionHTML(g)}</div>`
    + `<div class="now-rows">${rows}</div></div>`;
}

function paint() {
  const box = $('review');
  const html = last.groups.length
    // what the button does is said before it is pressed, not after: it makes a task and starts Claude
    ? `<div class="rv-note">${tr('The button makes a check task in the project and starts Claude on it: Claude checks every task listed with tests of its own, simulates failures, moves what passes to Done and leaves the report on the card of the check.')}</div>`
      + checkingFirst(last.groups, stateOf).map(groupHTML).join('')
    : `<div class="panel now-empty"><div class="now-empty-h">${tr('Nothing to check')}</div>`
      + `<div class="muted">${tr('Tasks show up here when Claude hands them in to Review.')}</div></div>`;
  keepFocus(box, () => { box.innerHTML = `<div class="now-wrap">${html}</div>`; });
  wireRows(box, openDrawer);
  wireProjectLinks(box);
  box.querySelectorAll('.rv-open').forEach((el) => { el.onclick = () => (el.dataset.terminal ? openTerminalOf(el.dataset.key) : openDrawer(el.dataset.key)); });
  box.querySelectorAll('.rv-go').forEach((el) => { el.onclick = () => startCheck(el); });
  sizeLive(box);
}

function sizeLive(box) {
  box.querySelectorAll('.rv-live').forEach((el) => {
    const r = el.getBoundingClientRect?.();
    if (r) el.style.setProperty('--rv-d', `${Math.ceil(Math.hypot(r.width, r.height))}px`);
  });
}
globalThis.addEventListener?.('resize', () => { if (state.slug === REVIEW && $('review')) sizeLive($('review')); });

async function startCheck(btn) {
  const g = last?.groups.find((x) => x.project === btn.dataset.project);
  if (g?.working?.length) { styledAlert(heldWhy(g.working)); return; }
  if (!g || !g.batch.length || g.running) return;
  await startCheckIn(g.project, g.batch, btn, renderReview);
}

export function heldWhy(keys) {
  return `${tr('Tasks of this project are still in work — the check can start when they reach Review:')} ${keys.join(', ')}. `
    + tr('A blocked task, or one stuck for two hours with no Claude on it, does not hold the check.');
}

export async function startCheckIn(project, batch, btn, again = () => {}) {
  btn.disabled = true;
  let task;
  try {
    const words = checkWords();
    const description = checkDescription(batch, words);
    task = await api('POST', '/api/tasks', { project, title: words.title, description, status: 'todo', labels: [CHECK_LABEL] }, { quiet: true });
  } catch (e) {
    if (e.status === 409 && e.body?.reason === 'check-open' && e.body.key) {
      openDrawer(e.body.key);
      again();
      return;
    }
    btn.disabled = false;
    styledAlert(refusalLine('Could not create the check', e, tr));
    return;
  }
  await launchInClaude({ text: taskPromptText(task.key), project, keys: [task.key], btn, check: true });
}

export function checkWords() {
  return {
    title: tr(CHECK_TITLE),
    tasks: tr('Tasks in Review when the check was started:'),
    later: tr('Tasks that reach Review after that are not part of this check.'),
    done: tr('Move each task that passes to Done with a command of its own and nothing around it: kb done <KEY>. That is the command the board allows; a loop or a script around it is stopped by the permission check of Claude Code.'),
    report: tr('Leave the report on this card: what was checked in each task and what was found.'),
    run: tr('Run the kanban skill'),
    doTask: tr('Do the task'),
  };
}

let seq = 0;
/** Draw the section from a fresh list of the tasks. */
export async function renderReview() {
  const my = ++seq;
  let list;
  // the open tasks of every project: the ones in Review, and any check still open
  try { list = await api('GET', '/api/tasks', undefined, { quiet: true }); }
  catch {
    if (!last && my === seq) $('review').innerHTML = `<div class="now-wrap"><div class="muted">${tr('Could not load the tasks in Review.')}</div></div>`;
    return; // a failed reload keeps the last picture rather than blanking it
  }
  if (state.slug !== REVIEW || my !== seq) return; // the person moved on, or a newer request is on its way
  const shown = [...document.querySelectorAll('#projects .proj[data-slug]')].map((el) => el.dataset.slug);
  const groups = reviewGroups(list, sidebarOrder(state.projects, shown), state.live);
  await Promise.all(groups.filter((g) => g.running).map(async (g) => {
    try {
      const t = await api('GET', `/api/tasks/${encodeURIComponent(g.running.key)}/terminal`, undefined, { quiet: true });
      g.terminal = { session: t.session || null, dead: Boolean(t.dead), question: Boolean(t.question) };
    } catch { /* no answer: the column says what it can */ }
  }));
  if (state.slug !== REVIEW || my !== seq) return;
  last = { groups, list };
  paint();
}

export function repaintReview() {
  if (!last || state.slug !== REVIEW) return;
  // a task whose session had closed and left out one a busy Claude was on, until the next event of a task
  for (const g of last.groups) g.working = last.list.filter((t) => t.project === g.project && holdsCheck(t, state.live)).map((t) => t.key);
  paint();
}
