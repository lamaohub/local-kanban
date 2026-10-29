
import { $, NOW, api, esc, ic, seg, state, tr } from './core.js';
import { IMAGE_ACCEPT, TERM_ACTIVITY, TERM_KEYS, cardTermSession, endedWords, growTermInput, openTerminalOf, rolledBy, sayRefused, setTermHint, takeTermHint, wireTermImages } from './drawer.js';
import { resumeOnBoard } from './sse.js';
import { popLayer, pushLayer, styledAlert, styledConfirm } from './sidebar.js';
import { refusalLine, refusalText } from './unsaved.js';
import { wireTermCopy } from './term-copy.js';
import { mountChat } from './chat.js';
import { getSetting, setClaudeView } from './settings.js';
import { holdUntil, reprinted } from './term-reprint.js';
import { localStore } from './store.js';

const POLL_MS = 1000;
const WORKING = new Set(['prep', 'doing', 'deploy']);
const cols = new Map(); // session → {el, key, win, seen, screen, layout, follow, ownTop, fit, live, pressed, req}
const drafts = new Map(); // session → an answer typed and not sent yet
const closed = new Map();
const claudeView = () => (getSetting('chatView') === 'chat' ? 'chat' : 'terminal');
const TASKS_KEY = 'kb.ui.nowColTasks';
const tasksClosed = () => { try { return localStore.getItem(TASKS_KEY) !== 'open'; } catch { return true; } };
function setTasksClosed(on) {
  try { localStore.setItem(TASKS_KEY, on ? 'closed' : 'open'); } catch { /* not remembered */ }
  for (const c of cols.values()) {
    // a chat read at its end stays at its end when the list over it grows or shrinks
    const log = c.el.querySelector('.now-col-chat .chat-log');
    const atEnd = log && log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const apply = () => {
      c.el.classList.toggle('tasks-closed', on);
      paintMore(c);
      if (atEnd) log.scrollTop = log.scrollHeight;
    };
    slideTasks(c, on, apply);
  }
}
const SLIDE_MS = 200;
function putRows(list, rows, cur) {
  if (list.dataset.rows !== rows) {
    list.dataset.rows = rows;
    list.innerHTML = cur ? rows.replace(`<div class="now-row" data-key="${cur}" `, `<div class="now-row now-row-cur" data-key="${cur}" `) : rows;
  }
  for (const row of list.querySelectorAll('.now-row')) row.classList.toggle('now-row-cur', row.dataset.key === cur);
}
function slideTasks(c, closing, apply) {
  const list = c.el.querySelector('.now-col-tasks');
  c.slide?.cancel();
  c.slide = null;
  if (!list?.animate || !list.getClientRects().length || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
  const from = list.offsetHeight;
  const others = () => [...list.querySelectorAll('.now-row:not(.now-row-cur)')];
  const timing = { duration: SLIDE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)' };
  let to;
  if (closing) {
    c.el.classList.add('tasks-closed');
    to = list.offsetHeight;
    c.el.classList.remove('tasks-closed');
  } else {
    apply();
    to = list.offsetHeight;
  }
  list.style.overflow = 'hidden';
  const a = list.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
  for (const row of others()) row.animate(closing ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], { ...timing, fill: closing ? 'forwards' : 'none' });
  c.slide = a;
  const done = () => {
    if (c.slide !== a) return; // a click meanwhile took over
    c.slide = null;
    list.style.overflow = '';
    if (closing) apply();
    for (const row of others()) for (const x of row.getAnimations()) x.cancel();
    if (c.rowsLater) { const { rows, cur } = c.rowsLater; c.rowsLater = null; putRows(list, rows, cur); }
  };
  a.finished.then(done, done);
}
/** The button under a column's tasks: how many there are while one is shown, «Collapse» while all are. */
function paintMore(c) {
  const more = c.el.querySelector('.now-col-more');
  const n = c.run?.tasks.length || 0;
  more.hidden = n < 2;
  const closed = c.el.classList.contains('tasks-closed');
  more.innerHTML = `${ic('chevron', 11)}<span>${esc(closed ? `${tr('Show all tasks')} (${n})` : tr('Collapse'))}</span>`;
  more.setAttribute('aria-expanded', String(!closed));
}
const CLOSED_HOLD_MS = 60000;
let timer = null;
let chain = 0;
let ticking = false; // a round of looks is on its way: a look asked for meanwhile waits for it, not beside it
let hurry = false;
let alive = false;   // the columns want looks: false once the section is left or shows the list

/** A half-typed answer in a column — the tab must not reload silently under it. */
export function columnsDirty() {
  return [...drafts.values()].some((t) => t.trim());
}

/** The task whose terminal a column shows: the one the session is on, else one still in work, else any of the run's. */
export function termTaskOf(run) {
  const t = run.tasks.find((x) => x.focus) || run.tasks.find((x) => WORKING.has(x.status)) || run.tasks[0];
  return t ? t.key : null;
}

function headHTML(board) {
  return '<div class="now-col-h"><div class="now-col-who">'
    + (board ? '<span class="term-state"></span>' : '')
    + '<span class="now-col-head"></span></div>'
    + (board ? '<div class="now-col-acts">'
      + `<button type="button" class="btn-primary now-col-resume" title="${esc(tr('Start Claude again in this terminal with its conversation — it waits for your word'))}" hidden>${esc(tr('Continue'))}</button>`
      + `<button type="button" class="btn-ghost now-col-close" title="${esc(tr('Close the terminal — its Claude stops'))}" aria-label="${esc(tr('Close the terminal — its Claude stops'))}">✕</button>`
      + `<button type="button" class="btn-ghost now-col-open">${esc(tr('Open in the card'))}</button></div>` : '')
    + '</div>';
}

function termHTML() {
  const down = esc(tr('To the end of the screen'));
  return '<div class="now-col-term">'
    + `<div class="now-col-scr"><pre class="term-screen now-col-screen"></pre><button type="button" class="btn-ghost now-col-down" title="${down}" aria-label="${down}" hidden>↓</button></div>`
    + `<div class="term-keys">${TERM_KEYS.map((k, i) => `<button type="button" class="btn-ghost term-key" data-i="${i}" title="${esc(tr(k.title))}" disabled>${esc(k.label)}</button>`).join('')}</div>`
    + `<div class="comment-form term-form"><textarea rows="1" autocomplete="off" placeholder="${esc(tr('Answer Claude…'))}" title="${esc(tr('Answer Claude… (↵ sends, ⇧↵ — new line)'))}" disabled></textarea>`
    + `<input type="file" class="hidden" accept="${IMAGE_ACCEPT}" multiple><button type="button" class="btn-ghost form-attach" disabled></button>`
    + `<button type="button" class="btn-ghost term-to-chat" title="${esc(tr('Show the chat'))}" aria-label="${esc(tr('Show the chat'))}">${ic('chat', 15)}</button>`
    + '<button type="button" class="btn-ghost term-send" disabled>↑</button></div>'
    + '</div>';
}

function noTermHTML(run) {
  const why = run.claude === 'unsent' ? 'The prompt is in the Claude app — press Enter there to start Claude'
    : !run.session ? 'These tasks were moved without a Claude session the board knows — by hand, or by a kb that does not say which session it is'
      : 'This Claude does not run inside the board — its screen is in the Terminal app or the Claude app.';
  return `<div class="now-col-none muted">${esc(tr(why))}</div>`;
}

/** How many columns of the screen fit the column — measured, the width of a monospace glyph differs between systems. */
function fitCols(c) {
  const pre = c.el.querySelector('.now-col-screen');
  const width = pre?.clientWidth || 0;
  if (!width) return null;
  if (c.fit && c.fit.width === width) return c.fit.cols;
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(100);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  pre.appendChild(probe);
  const ch = probe.getBoundingClientRect().width / 100;
  probe.remove();
  const cs = getComputedStyle(pre);
  const room = width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  c.fit = { width, cols: ch > 0 ? Math.min(300, Math.max(20, Math.floor(room / ch))) : null };
  return c.fit.cols;
}

const selectingIn = (el) => {
  const sel = document.getSelection?.();
  return Boolean(sel && !sel.isCollapsed && (el.contains(sel.anchorNode) || el.contains(sel.focusNode)));
};

function paintTerm(c, r) {
  const st = c.el.querySelector('.term-state');
  const gone = !r.session;
  const live = !gone && !r.dead;
  const lost = gone && Boolean(c.run?.ended?.lost);
  st.textContent = lost ? tr('Session interrupted') : gone ? tr('Not running') : r.dead ? endedWords(r) : tr(TERM_ACTIVITY[r.activity] || 'Running');
  const go = c.el.querySelector('.now-col-resume');
  if (go) go.hidden = !((r.dead && r.session) || lost);
  st.title = r.dead && !gone ? endedWords(r, true) : st.textContent;
  st.classList.toggle('live', live);
  st.classList.toggle('calm', live && r.activity !== undefined && !['busy', 'background', 'own'].includes(r.activity));
  c.el.querySelectorAll('.term-key, .term-send, .form-attach, textarea').forEach((b) => { b.disabled = !live; });
  c.live = live;
  c.ended = !live;
  c.activity = live ? r.activity : null;
  hintColumn(c);
  const pre = c.el.querySelector('.now-col-screen');
  const text = r.screen || '';
  if (c.hold) {
    if (live && Date.now() < c.hold && !reprinted(text, r.cols)) { c.seen = null; return; }
    c.hold = 0;
    if (text !== c.screen) c.follow = true; // printed anew: what was in sight is elsewhere now, the end is where it was
  }
  if (text === c.screen) return;
  if (c.pressed || selectingIn(pre)) { c.seen = null; return; } // the person selects on the screen: redraw once they let go
  const rolled = c.follow ? 0 : rolledBy(c.screen, text);
  c.screen = text;
  c.layout = { wraps: r.wraps || [], cols: r.cols || 0 };
  pre.textContent = text;
  if (c.follow) pre.scrollTop = pre.scrollHeight;
  else if (rolled) pre.scrollTop = Math.max(0, pre.scrollTop - rolled * (pre.scrollHeight / text.split('\n').length));
  c.ownTop = pre.scrollTop;
  c.el.querySelector('.now-col-down').hidden = c.follow;
}

export function askCols(fit, win) {
  if (win === undefined) return null; // no answer yet
  if (win === null) return fit || null; // the server does not know the window's width: the column's
  return fit && (fit < win || fit > win + 2) ? fit : null;
}

const hintColumn = (c) => setTermHint(c.el.querySelector('textarea'), { key: c.key, status: c.status, activity: c.activity ?? null });

const CHAT_LOOK_MS = 5000;
async function look(c) {
  if (!c.key || !c.el.querySelector('.now-col-screen') || !inSight(c)) return;
  if (c.view === 'chat' && Date.now() - (c.lookedAt || 0) < CHAT_LOOK_MS) return;
  c.lookedAt = Date.now();
  const q = new URLSearchParams();
  const n = cardHolds(c) ? null : askCols(fitCols(c), c.win);
  if (n) q.set('cols', n);
  if (c.seen) q.set('seen', c.seen);
  const n2 = ++c.req;
  let r;
  try { r = await api('GET', `/api/tasks/${seg(c.key)}/terminal?${q}`, undefined, { quiet: true }); } catch { return; }
  if (n2 !== c.req) return; // a newer look has answered already
  if (r.same) return;
  c.seen = r.v || null;
  const was = c.win;
  c.win = r.cols || null; // a known window, or null — the server could not say
  if (!r.dead) c.hold = holdUntil(c.hold, was, c.win);
  paintTerm(c, r);
}

async function send(c, body) {
  if (!c.key || !c.live) return false;
  // an answer is to see what Claude did with it: a selection on the screen would hold it still (the card does the same)
  c.pressed = false;
  if (selectingIn(c.el.querySelector('.now-col-screen'))) document.getSelection().removeAllRanges();
  try { await api('POST', `/api/tasks/${seg(c.key)}/terminal`, body, { quiet: true }); } catch (e) {
    if (refusalText(e).gone) sayRefused(e, c.key); // the task is gone: said in the board's words, the board read again
    else styledAlert(refusalLine('Could not type into the terminal', e, tr));
    return false;
  }
  c.follow = true;
  c.seen = null;
  soon(250);
  return true;
}

async function closeColumn(c) {
  if (!c.key) return;
  if (!c.ended && !await styledConfirm(tr('Close this terminal? Its Claude stops at once.'), { okLabel: tr('Close'), danger: true })) return;
  try { await api('DELETE', `/api/tasks/${seg(c.key)}/terminal`, undefined, { quiet: true }); } catch (e) {
    if (refusalText(e).gone) { sayRefused(e, c.key); return; }
    if (e?.status !== 404) { styledAlert(refusalLine('Could not stop Claude', e, tr)); return; } // 404: no terminal any more
  }
  closed.set(c.id, Date.now());
  drafts.delete(c.id);
  drop(c);
  cols.delete(c.id);
  if (!cols.size) stop();
}

/** The runs whose column is not closed from the column a moment ago (the server sees it a few seconds later). */
export function openRuns(runs, now = Date.now()) {
  const ids = new Set(runs.map((r) => r.session).filter(Boolean));
  for (const [id, at] of closed) if (!ids.has(id) || now - at > CLOSED_HOLD_MS) closed.delete(id);
  return runs.filter((r) => !(r.session && closed.has(r.session)));
}

function wire(c) {
  const el = c.el;
  el.querySelector('.now-col-open').onclick = () => openTerminalOf(c.key);
  el.querySelector('.now-col-close').onclick = () => closeColumn(c);
  const again = el.querySelector('.now-col-resume');
  if (again) again.onclick = async () => { if (await resumeOnBoard({ key: c.key, session: c.run?.session, btn: again })) { c.seen = null; c.lookedAt = 0; c.follow = true; soon(250); } };
  el.querySelector('.term-to-chat').onclick = () => setClaudeView('chat');
  el.querySelectorAll('.term-key').forEach((b) => {
    const k = TERM_KEYS[Number(b.dataset.i)];
    b.onclick = () => send(c, k.key ? { key: k.key } : { text: k.text });
  });
  const input = el.querySelector('textarea');
  input.value = drafts.get(c.id) || '';
  const go = async () => {
    const text = input.value;
    if (await send(c, text ? { text, key: 'Enter' } : { key: 'Enter' })) { input.value = ''; drafts.delete(c.id); growTermInput(input); }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { input.blur(); e.stopPropagation(); return; }
    if (takeTermHint(e, input)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
  };
  input.oninput = () => { growTermInput(input); if (input.value) drafts.set(c.id, input.value); else drafts.delete(c.id); };
  wireTermImages(input, () => c.key);
  el.querySelector('.term-send').onclick = go;
  const pre = el.querySelector('.now-col-screen');
  pre.onpointerdown = (e) => { c.pressed = e.button === 0; }; // a slow drag has selected nothing yet — hold the redraw
  pre.oncontextmenu = () => { c.pressed = false; };
  wireTermCopy(pre, () => c.layout || {});
  sizeScreen(c);
  const down = el.querySelector('.now-col-down');
  down.onclick = () => { c.follow = true; pre.scrollTop = pre.scrollHeight; c.ownTop = pre.scrollTop; down.hidden = true; };
  pre.onscroll = () => {
    c.follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    down.hidden = c.follow;
    if (pre.scrollTop === c.ownTop) return;
    c.ownTop = -1;
    pre.classList.add('scrolling');
    clearTimeout(c.barTimer);
    c.barTimer = setTimeout(() => pre.classList.remove('scrolling'), 900);
  };
}

function sizeScreen(c) {
  if (typeof ResizeObserver !== 'function') return;
  const box = c.el.querySelector('.now-col-term');
  const scr = box.querySelector('.now-col-scr');
  const pre = scr.querySelector('.now-col-screen');
  const fit = () => {
    const rest = [...box.children].filter((e) => e !== scr);
    const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
    const h = Math.floor(box.clientHeight - rest.reduce((n, e) => n + e.offsetHeight, 0) - gap * rest.length);
    if (h <= 0) return; // not laid out yet
    if (pre.style.getPropertyValue('--scr-h') === `${h}px` && pre.classList.contains('sized')) return;
    pre.style.setProperty('--scr-h', `${h}px`);
    pre.classList.add('sized');
    scr.classList.add('sized');
    if (c.follow) pre.scrollTop = pre.scrollHeight; // the field grew over the screen: its last rows stay in sight
  };
  c.sizer = new ResizeObserver(fit);
  c.sizer.observe(box);
  c.sizer.observe(box.querySelector('.term-form'));
}

/** The choice in Settings changed: every column shows Claude the new way at once. */
export function repaintColumnViews() {
  for (const c of cols.values()) if (c.run) showView(c, c.run);
}

const sight = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  let back = false;
  for (const e of entries) {
    const c = [...cols.values()].find((x) => x.el === e.target);
    if (!c) continue;
    const away = !e.isIntersecting;
    if (away === Boolean(c.away)) continue;
    c.away = away;
    c.chat?.show(!away && c.view === 'chat');
    if (!away) { c.lookedAt = 0; back = true; }
  }
  if (back) soon(0);
}, { rootMargin: '200px' }) : null;
const inSight = (c) => !c.away || fullCol === c;
const drop = (c) => { if (fullCol === c) setColumnFull(c, false, { quiet: true }); sight?.unobserve(c.el); c.sizer?.disconnect(); c.chat?.destroy(); c.el.remove(); };

const FULL_MS = 260;
let fullCol = null; // the column on the full screen
export function setColumnFull(c, on, { quiet = false } = {}) {
  if (!c?.el || on === (fullCol === c)) return;
  if (on && fullCol) setColumnFull(fullCol, false, { quiet: true });
  const el = c.el;
  const reading = c.chat?.holdReading?.(); // a reader up in the chat keeps the turn they read
  // where it stands now — midway too, before that move is cut (review: measured after, a column going back and sent out
  // again was taken for one over the window, and its place in the row was made the size of the window)
  const from = el.getBoundingClientRect();
  const padFrom = getComputedStyle(el).paddingLeft;
  el.getAnimations?.().forEach((a) => { if (a.id === 'col-full') a.cancel(); });
  el.classList.remove('col-full', 'col-leaving');
  c.place?.remove();
  const slot = el.getBoundingClientRect(); // its place in the row
  const hold = () => { // the place it leaves holds its size in the row while it is away, and while it goes back
    c.place = c.place || document.createElement('div');
    c.place.className = 'now-col-place';
    Object.assign(c.place.style, { width: `${slot.width}px`, height: `${slot.height}px` });
    el.after(c.place);
  };
  // held before the column leaves the row: measured over the window with its place empty, the row closed the gap for a
  if (on) hold();
  // the section stays where the person stood: WebKit scrolls it behind a column on the full screen (to the column's
  const page = el.closest?.('#now');
  if (on) c.pageTop = page?.scrollTop;
  const putPage = () => { if (page && c.pageTop != null && page.scrollTop !== c.pageTop) page.scrollTop = c.pageTop; };
  el.classList.toggle('col-full', on);
  if (!on) putPage();
  const to = on ? el.getBoundingClientRect() : slot;
  const padTo = getComputedStyle(el).paddingLeft;
  fullCol = on ? c : null;
  if (on) pushLayer('col-full', () => setColumnFull(c, false)); else popLayer('col-full');
  const still = quiet || !el.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const done = () => {
    if (fullCol !== c) {
      el.classList.remove('col-full', 'col-leaving');
      c.place?.remove();
      c.place = null;
      putPage();
      c.pageTop = null;
    }
    reading?.();
  };
  if (!on && !still) hold();
  if (!on && !still) el.classList.add('col-full', 'col-leaving'); // shrinks as a fixed column, to where it will stand
  if (!still) {
    const box = (r, pad) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto', paddingLeft: pad, paddingRight: pad });
    el.animate([box(from, padFrom), box(to, padTo)], { duration: FULL_MS, easing: 'cubic-bezier(.2, .7, .2, 1)', id: 'col-full' }).finished.then(done, () => reading?.()); // cut short: the next move holds
  } else done();
  document.dispatchEvent(new CustomEvent('kb:column-full', { detail: { on, id: c.id } }));
}

/** The column as a chat or as its terminal. A run without a session the board knows has neither: it keeps its words. */
function showView(c, run) {
  c.run = run;
  const key = termTaskOf(run);
  const can = Boolean(run.session && key);
  const view = !can ? 'none' : !c.board ? 'chat' : claudeView();
  const chatBox = c.el.querySelector('.now-col-chat');
  chatBox.classList.toggle('hidden', view !== 'chat');
  c.el.querySelector('.now-col-term')?.classList.toggle('hidden', view === 'chat');
  c.el.querySelector('.now-col-body')?.classList.toggle('hidden', view === 'chat');
  c.view = view;
  c.el.classList.toggle('as-chat', view === 'chat');
  if (view !== 'chat') { c.chat?.show(false); return; }
  if (!c.chat) c.chat = mountChat(chatBox, { key, session: run.session, full: { on: () => fullCol === c, set: (v) => setColumnFull(c, v) } });
  else if (c.chatFor !== `${key} ${run.session}`) c.chat.setKey(key, run.session);
  c.chatFor = `${key} ${run.session}`;
  c.chat.show(inSight(c));
}

const SCROLLED = '.chat-log, .now-col-screen, .now-col-tasks';
export function placeColumn(box, el, at) {
  const kept = [...el.querySelectorAll(SCROLLED)].map((x) => [x, x.scrollTop]);
  box.insertBefore(el, at);
  for (const [x, top] of kept) if (x.scrollTop !== top) x.scrollTop = top;
}

const runId = (run) => run.session || `loose ${run.tasks[0]?.project} ${run.claude}`;

/** Lay the live runs out as columns in `box`, keeping the columns that are already there. `head(run, {board})` and
    `tasks(run, {board})` draw the header and the batch of a run in a column (`board` — the column shows a terminal). */
export function syncColumns(box, runs, { head, tasks }) {
  const want = new Set(runs.map(runId));
  for (const [id, c] of cols) if (!want.has(id)) { drop(c); cols.delete(id); }
  let prev = null;
  for (const run of runs) {
    const id = runId(run);
    let c = cols.get(id);
    const board = Boolean(run.session && run.board);
    if (!c || c.board !== board || !box.contains(c.el)) {
      const el = document.createElement('div');
      el.className = 'panel now-col';
      el.innerHTML = headHTML(board) + '<div class="now-col-tasks"></div><button type="button" class="now-col-more" hidden></button>'
        + (board ? termHTML() : '<div class="now-col-body"></div>') + '<div class="now-col-chat hidden"></div>';
      el.classList.toggle('tasks-closed', tasksClosed());
      el.querySelector('.now-col-more').onclick = () => setTasksClosed(!el.classList.contains('tasks-closed'));
      c = { id, el, board, key: null, seen: null, screen: null, follow: true, ownTop: -1, fit: null, live: false, ended: false, pressed: false, req: 0 };
      const col = c;
      el.addEventListener?.('click', (e) => { if (fullCol === col && e.target.closest?.('.now-row, .now-col-open')) setColumnFull(col, false, { quiet: true }); }, true);
      if (board) wire(c);
      if (cols.has(id)) drop(cols.get(id));
      cols.set(id, c);
      sight?.observe(el);
    }
    const key = board ? termTaskOf(run) : null;
    if (key !== c.key) { c.key = key; c.seen = null; c.win = undefined; c.activity = null; c.hold = 0; }
    c.status = run.tasks.find((t) => t.key === key)?.status || null;
    if (board) hintColumn(c); // a status changed with the screen as it was (its looks come back «same»)
    c.el.classList.toggle('stale', Boolean(run.stale));
    const headEl = c.el.querySelector('.now-col-head');
    headEl.innerHTML = head(run, { board });
    // a narrow column hides the time and the count, and cuts the project: the whole line is in the tooltip
    c.el.querySelector('.now-col-who').title = [...headEl.children].map((e) => e.textContent.trim()).filter(Boolean).join(' · ');
    const list = c.el.querySelector('.now-col-tasks');
    // the list slides, new rows wait for the next look
    const rows = tasks(run, { board });
    const cur = termTaskOf(run);
    if (c.slide) c.rowsLater = { rows, cur }; else putRows(list, rows, cur);
    if (!board) c.el.querySelector('.now-col-body').innerHTML = noTermHTML(run);
    showView(c, run);
    paintMore(c);
    // in the order of the runs, moving a column only when it stands in the wrong place (a move resets its scroll)
    let at = prev ? prev.nextSibling : box.firstChild;
    if (at?.classList?.contains('now-col-place')) at = at.nextSibling;
    if (at !== c.el) placeColumn(box, c.el, at);
    prev = c.el;
  }
  if (cols.size) start(); else stop();
}

/** The section is gone from the screen or shows the list: the columns are dropped and nobody is looked at. */
export function dropColumns() {
  for (const c of cols.values()) drop(c);
  cols.clear();
  stop();
}

const shown = () => state.slug === NOW && !$('now').classList.contains('hidden');
// the card's Terminal tab on screen lays its window out for the card's width — the column of that terminal leaves it so
const cardTerminal = () => Boolean(state.drawerKey) && !$('term-block').classList.contains('hidden');
const cardHolds = (c) => cardTerminal() && (c.key === state.drawerKey || (Boolean(c.id) && c.id === cardTermSession()));
// the mouse button is let go anywhere on the page, not only over the screen
globalThis.addEventListener?.('pointerup', () => { for (const c of cols.values()) c.pressed = false; });

function schedule(ms, n) { timer = setTimeout(() => tick(n), ms); }
async function tick(n) {
  timer = null;
  if (!shown() || !cols.size) { stop(); return; }
  ticking = true;
  try {
    if (!document.hidden) await Promise.all([...cols.values()].map(look));
  } finally { ticking = false; }
  if (!alive || timer) return;
  // stopped and started again while this round was on its way: its chain is over, a new one begins now
  if (n !== chain) { schedule(0, ++chain); return; }
  schedule(hurry ? 0 : POLL_MS, n);
  hurry = false;
}
function start() {
  if (alive) return;
  alive = true;
  if (!ticking) schedule(0, ++chain);
}
function stop() {
  alive = false; clearTimeout(timer); timer = null; chain++; hurry = false;
  if (fullCol) setColumnFull(fullCol, false, { quiet: true });
}
/** Look again soon (after typing) — as the next look of the chain, never as a second one beside a look on its way. */
function soon(ms) {
  if (ticking) { hurry = true; return; }
  if (!timer) return;
  clearTimeout(timer);
  schedule(ms, ++chain);
}
