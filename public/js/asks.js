import { $, api, esc, ic, state, tr } from './core.js';
import { answerBody, askSummary, mergeAsks, missedNote, OTHER, questionsOf, refusedNote, removalNote } from './ask-rules.js';
import { repaintLiveBadges } from './board.js';
import { chatAsksChanged, chatTakesAsk } from './chat.js';

let asks = [];             // pending requests of every task
const sending = new Set(); // request ids whose answer is on its way
let notices = [];          // [{id, key, text, until}] — a request that went away without an answer from here
// would pass it off as given, and its form stood frozen after a 409)
const lostHandlers = new Map();
// A block's buttons wake up a moment after it appears: a click meant for something else must not land on a
// request that just slid in under the pointer (the board refuses an answer that early too — EARLIEST_ANSWER_MS).
const HOLD_MS = 800;

// The event stream is newer than any list fetched before it ended (mergeAsks in ask-rules.js)
let seq = 0;            // live events so far
const gone = new Set(); // ids the stream removed (the latest few hundred)

/** Whether a task has a request waiting for the person. */
export const hasAsk = (taskId) => asks.some((a) => String(a.task_id) === String(taskId));
export const pendingAsks = () => asks.slice();
export const isSending = (id) => sending.has(id);
export const questionAsk = (key, session) => asks.find((a) => a.key === key && a.kind === 'question'
  && (!session || !a.session_id || a.session_id === session)) || null;

export async function loadAsks() {
  const from = seq;
  let list;
  try { list = await api('GET', '/api/asks', undefined, { quiet: true }); } catch { return; }
  if (!Array.isArray(list)) return;
  const shown = asks;
  asks = mergeAsks(list, asks, gone, from);
  repaintLiveBadges();
  chatAsksChanged();
  renderAsks();
  // restarted, vanished without a word — ask the board what became of it
  for (const a of shown) if (a.key === state.drawerKey && !asks.some((x) => x.id === a.id)) explainMissed(a);
}

const notify = (a, text) => {
  if (!text || notices.some((n) => n.id === a.id)) return;
  notices.push({ id: a.id, key: a.key, text, until: Date.now() + 8000 });
  setTimeout(renderAsks, 8100);
};

async function explainMissed(a) {
  let fate = null;
  let body = null;
  try { fate = await api('GET', `/api/asks/${encodeURIComponent(a.id)}`, undefined, { quiet: true }); } catch (e) {
    if (e.status !== 404) return; // no connection again: nothing certain to say
    body = e.body;
  }
  notify(a, missedNote(fate, { startedAt: body?.started_at, createdAt: a.created_at, sentHere: sending.has(a.id) }));
  sending.delete(a.id);
  renderAsks();
}

/** `ask.created` / `ask.removed` from the event stream. */
export function applyAskEvent(ev) {
  const d = ev.data || {};
  seq++;
  if (ev.type === 'ask.created') {
    if (!gone.has(d.id) && !asks.some((a) => a.id === d.id)) asks.push({ ...d, seq });
  } else {
    gone.add(d.id);
    if (gone.size > 500) gone.delete(gone.values().next().value);
    const was = asks.find((a) => a.id === d.id);
    asks = asks.filter((a) => a.id !== d.id);
    // answered in Claude itself (or the wait ran out) while the card showed it: say so, not vanish silently — and
    // so for an answer sent from here that the hook never picked up (removalNote in ask-rules.js)
    const note = was && state.drawerKey === was.key ? removalNote(d.outcome, sending.has(d.id)) : null;
    const lost = lostHandlers.get(d.id);
    lostHandlers.delete(d.id);
    if (lost && d.outcome !== 'decided' && sending.has(d.id)) { try { lost(removalNote(d.outcome, true)); } catch (e) { console.error(e); } }
    if (note) {
      notices.push({ id: d.id, key: was.key, text: note, until: Date.now() + 8000 });
      setTimeout(renderAsks, 8100);
    }
  }
  repaintLiveBadges();
  chatAsksChanged();
  // that answer, and the chat lets the form fade out then (`isSending`); forgotten before, the form went in 10ms
  if (ev.type !== 'ask.created') sending.delete(d.id);
  renderAsks();
}

const HEAD = {
  permission: 'Claude asks for permission',
  question: 'Claude asks you',
  plan: 'Claude suggests a plan',
};

// Ghostex does); the label goes back to Claude as it came
const RECOMMENDED = /\s*\((?:recommended|рекоменд[а-яё]*)\)\s*$/i;
export const plainLabel = (label) => String(label ?? '').replace(RECOMMENDED, '');

function questionHTML(a, qi, q, n) {
  const name = `ask-${a.id}-${qi}`;
  const type = q.multiSelect ? 'checkbox' : 'radio';
  const opts = q.options.map((o) => {
    const rec = RECOMMENDED.test(o.label);
    return `<label class="ask-opt"><input type="${type}" name="${esc(name)}" value="${esc(o.label)}">
      <span class="ask-opt-b"><span class="ask-opt-l">${esc(o.label.replace(RECOMMENDED, ''))}${rec ? `<span class="ask-rec">${esc(tr('recommended'))}</span>` : ''}</span>`
      + `${typeof o.description === 'string' && o.description ? `<span class="ask-opt-desc">${esc(o.description)}</span>` : ''}</span></label>`;
  }).join('');
  const head = [n > 1 ? `${qi + 1}/${n}` : '', typeof q.header === 'string' ? q.header : ''].filter(Boolean).join(' · ');
  return `<div class="ask-q">
    ${head ? `<div class="ask-q-head">${esc(head)}${q.multiSelect ? ` · ${esc(tr('several can be picked'))}` : ''}</div>` : ''}
    <div class="ask-q-text">${esc(q.question)}</div>
    ${opts}
    <label class="ask-opt ask-opt-other"><input type="${type}" name="${esc(name)}" value="${OTHER}"><span>${esc(tr('Something else'))}:</span>
      <textarea class="ask-other" rows="1" placeholder="${esc(tr('Your own answer'))}"></textarea></label>
    <input type="text" class="ask-qnote" placeholder="${esc(tr('A note to this answer — Claude will read it'))}">
  </div>`;
}

// shown when the command or the plan does not fit its box: macOS hides the scrollbar until one scrolls, and a box
// that looks complete must not be taken for the whole of it
const LONG = () => `<div class="ask-long hidden">${esc(tr('It does not all fit — scroll to the end before answering'))}</div>`;

function askHTML(a) {
  const meta = [a.kind === 'permission' ? a.tool : '', a.agent_id ? tr('helper') : ''].filter(Boolean).join(' · ');
  let body;
  let actions;
  if (a.kind === 'question') {
    const qs = questionsOf(a);
    body = qs.map((q, i) => questionHTML(a, i, q, qs.length)).join('');
    actions = `<input type="text" class="ask-reason" placeholder="${esc(tr('Why not — Claude will read it'))}">
      <button type="button" class="btn-primary ask-allow">${esc(tr('Answer'))}</button>
      <button type="button" class="btn-ghost ask-deny">${esc(tr('Decline'))}</button>`;
  } else if (a.kind === 'plan') {
    body = `<div class="ask-plan">${esc(typeof a.input?.plan === 'string' && a.input.plan ? a.input.plan : tr('The plan is empty'))}</div>${LONG()}`;
    actions = `<input type="text" class="ask-reason" placeholder="${esc(tr('What to change — Claude will read it'))}">
      <button type="button" class="btn-primary ask-allow">${esc(tr('Approve'))}</button>
      <button type="button" class="btn-ghost ask-deny">${esc(tr('Reject'))}</button>`;
  } else {
    body = `<pre class="ask-what">${esc(askSummary(a))}</pre>${LONG()}`;
    actions = `<input type="text" class="ask-reason" placeholder="${esc(tr('Reason — Claude will read it'))}">
      <button type="button" class="btn-primary ask-allow">${esc(tr('Allow'))}</button>
      <button type="button" class="btn-ghost ask-deny">${esc(tr('Deny'))}</button>`;
  }
  return `<div class="ask" data-id="${esc(a.id)}">
    <div class="ask-head">${ic('bot', 13)}<span>${esc(tr(HEAD[a.kind] || HEAD.permission))}</span>${meta ? `<span class="ask-meta">${esc(meta)}</span>` : ''}</div>
    ${body}<div class="ask-actions">${actions}</div><div class="ask-err hidden"></div></div>`;
}

/** The block on top of the open card: the requests of its task, and notes about requests answered elsewhere.
    Each request keeps its own block for as long as it waits: what the person picked or typed, and the buttons
    of an answer on its way, live through another request coming or going next to it. */
export function renderAsks() {
  const el = $('d-asks');
  if (!el) return;
  const key = state.drawerKey;
  notices = notices.filter((n) => n.until > Date.now());
  const own = key ? asks.filter((a) => a.key === key && !(a.kind === 'question' && chatTakes(a.id))) : [];
  const notes = key ? notices.filter((n) => n.key === key) : [];
  el.classList.toggle('hidden', !own.length && !notes.length);
  const want = new Set(own.map((a) => a.id));
  for (const box of [...el.querySelectorAll(':scope > .ask[data-id]')]) if (!want.has(box.dataset.id)) box.remove();
  let notesEl = el.querySelector(':scope > .ask-notes');
  if (!notesEl) {
    notesEl = document.createElement('div');
    notesEl.className = 'ask-notes';
    el.append(notesEl);
  }
  for (const a of own) {
    if (el.querySelector(`:scope > .ask[data-id="${CSS.escape(a.id)}"]`)) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = askHTML(a).trim();
    const box = tpl.content.firstElementChild;
    el.insertBefore(box, notesEl);
    wire(box, a);
  }
  const drawn = notes.map((n) => n.text).join('|');
  if (notesEl.dataset.drawn !== drawn) {
    notesEl.dataset.drawn = drawn;
    notesEl.innerHTML = notes.map((n) => `<div class="ask ask-note">${esc(tr(n.text))}</div>`).join('');
  }
}

const chatTakes = (id) => { try { return chatTakesAsk(id); } catch { return false; } };

export function askBlock(a, { onSent, onLost } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = askHTML(a).trim();
  const box = tpl.content.firstElementChild;
  if (onLost) lostHandlers.set(a.id, onLost);
  wire(box, a, onSent);
  return box;
}

const OTHER_MAX_PX = 160; // the answer of one's own grows to this, then scrolls

function readForm(box, a) {
  const reason = box.querySelector('.ask-reason')?.value || '';
  if (a.kind !== 'question') return { reason };
  const picks = [...box.querySelectorAll('.ask-q')].map((qEl) => ({
    checked: [...qEl.querySelectorAll('.ask-opt > input:checked')].map((i) => i.value),
    other: qEl.querySelector('.ask-other')?.value || '',
    note: qEl.querySelector('.ask-qnote')?.value || '',
  }));
  return { reason, picks };
}

function wire(box, a, onSent) {
  if (!box) return;
  const err = box.querySelector('.ask-err');
  const buttons = () => box.querySelectorAll('button');
  const fail = (text) => { err.textContent = text; err.classList.remove('hidden'); };
  buttons().forEach((b) => { b.disabled = true; });
  setTimeout(() => { if (!sending.has(a.id)) buttons().forEach((b) => { b.disabled = false; }); }, HOLD_MS);
  requestAnimationFrame(() => {
    const view = box.querySelector('.ask-what, .ask-plan');
    if (view && view.scrollHeight > view.clientHeight + 2) box.querySelector('.ask-long')?.classList.remove('hidden');
  });
  const send = async (allow) => {
    let body;
    try { body = answerBody(a, allow, readForm(box, a)); } catch (e) { fail(tr(e.message)); return; }
    err.classList.add('hidden');
    buttons().forEach((b) => { b.disabled = true; });
    sending.add(a.id);
    try {
      await api('POST', `/api/asks/${encodeURIComponent(a.id)}/decision`, body, { quiet: true });
      // the request leaves the card with `ask.removed` once the hook has the answer; what the chat draws of it is the
      // chat's — a fault there is not a failed answer (the board has it: a second click would be refused)
      try { onSent?.(body); } catch (e) { console.error(e); }
    } catch (e) {
      sending.delete(a.id);
      if (e.status === 404 || e.status === 409) {
        asks = asks.filter((x) => x.id !== a.id);
        // the event that took the request away may have come first and said so already — or said nothing: another
        const why = refusedNote(e.body?.reason, { startedAt: e.body?.started_at, createdAt: a.created_at });
        notify(a, why);
        // and in a column there was none at all; the buttons stayed grey for good
        const lost = lostHandlers.get(a.id);
        lostHandlers.delete(a.id);
        try { lost?.(why); } catch (err) { console.error(err); }
        repaintLiveBadges();
        chatAsksChanged();
        renderAsks();
        return;
      }
      buttons().forEach((b) => { b.disabled = false; });
      fail(tr(e.offline ? 'No connection to the board — try again' : 'Could not send the answer'));
    }
  };
  box.querySelector('.ask-allow')?.addEventListener('click', () => send(true));
  box.querySelector('.ask-deny')?.addEventListener('click', () => send(false));
  // as wide as a word showed the end of a long answer only
  box.querySelectorAll('.ask-other').forEach((inp) => inp.addEventListener('input', () => {
    const pick = inp.closest('.ask-opt')?.querySelector('input[type=radio], input[type=checkbox]');
    if (pick && inp.value.trim()) pick.checked = true;
    inp.style.height = 'auto';
    inp.style.height = `${Math.min(inp.scrollHeight + 2, OTHER_MAX_PX)}px`;
  }));
}
