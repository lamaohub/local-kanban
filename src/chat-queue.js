
import { emit } from './bus.js';
import { db, logError } from './db.js';
import { isPreviewBoard } from './config.js';
import { claudeAtPrompt, phantomPane } from './phantom.js';
import { resolveTask } from './routes/tasks.js';
import { sayToTerminal } from './terminal-say.js';

export const QUEUE_IDLE_MS = 2000;  // how long Claude must have waited at its prompt before the next words go
export const QUEUE_MAX = 20;        // per session — a page that keeps sending to a stuck Claude stops here
const TICK_MS = 500;
export const DELIVER_TRIES = 3;
export const NO_BOX_HOLD_MS = 5 * 60_000; // how long queued words wait for Claude's input field to show before they are said not delivered

const queues = new Map();
const idleSince = new Map(); // session → since when it has been seen at its prompt
const stuckLook = new Map(); // session → when tmux was last asked whether the terminal of words not delivered is still there
const STUCK_LOOK_MS = 5000;
let seq = 0;
let timer = null;
const paneGone = async (session) => (await phantomPane(session)) === null;
const REAL = { atPrompt: claudeAtPrompt, gone: paneGone, say: sayToTerminal, task: (id) => resolveTask(String(id)), timer: true };
let deps = REAL;
/** Tests put fakes for tmux here (and `timer: false` — they tick by hand); `null` puts the real ones back. */
export function setQueueDeps(d) { deps = d ? { ...REAL, ...d } : REAL; }

const ring = (session) => emit('session.chat', { session });

/** Write the queue of `session` as it is now (none — its rows go). A failed write leaves the queue in memory working. */
function keep(session) {
  try {
    const q = queues.get(session) || [];
    db.transaction(() => {
      db.prepare('DELETE FROM chat_queue WHERE session_id = ?').run(session);
      const add = db.prepare(`INSERT INTO chat_queue (id, session_id, task_id, text, images, ids, at, tries, stuck, no_box_since, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      q.forEach((it, i) => add.run(it.id, session, it.task, it.text, JSON.stringify(it.images || []), JSON.stringify(it.ids || []), it.at,
        it.tries || 0, it.stuck || null, it.noBoxSince ?? null, i));
    })();
  } catch (e) { logError('server', 'chat', `the queue of words could not be kept: ${e.message}`); }
}
const list = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; } };
/** The queues kept before the board last stopped, back in memory; the ticking starts if any wait. */
export function loadQueues() {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM chat_queue ORDER BY session_id, position').all(); } catch { return 0; }
  for (const r of rows) {
    const q = queues.get(r.session_id) || [];
    q.push({ id: r.id, text: r.text, images: list(r.images), ids: list(r.ids), at: r.at, task: r.task_id,
      ...(r.tries ? { tries: r.tries } : {}), ...(r.stuck ? { stuck: r.stuck } : {}), ...(r.no_box_since !== null ? { noBoxSince: r.no_box_since } : {}) });
    queues.set(r.session_id, q);
    seq = Math.max(seq, Number(/^q(\d+)$/.exec(r.id)?.[1]) || 0);
  }
  if (queues.size) start();
  return rows.length;
}

const locks = new Map();  // session → the typing in progress
const saidAt = new Map(); // session → when words were typed into it last
export function typing(session, fn) {
  const run = (locks.get(session) || Promise.resolve()).then(fn);
  const settled = run.catch(() => {});
  locks.set(session, settled);
  settled.then(() => { if (locks.get(session) === settled) locks.delete(session); });
  return run;
}
/** Words typed into `session` just now — the next ones wait (the chat's POST queues them). */
export const saidLately = (session, now = Date.now()) => now - (saidAt.get(session) || 0) < QUEUE_IDLE_MS;
export const markSaid = (session, now = Date.now()) => saidAt.set(session, now);

/** What waits for `session`, oldest first (a copy). */
export const queued = (session) => (queues.get(session) || [])
  .map(({ id, text, images, at, stuck }) => ({ id, text, ...(images.length ? { images_n: images.length } : {}), at: new Date(at).toISOString(), ...(stuck ? { stuck } : {}) }));

export function enqueue(session, taskId, text, images = [], ids = []) {
  const q = queues.get(session) || [];
  if (q.length >= QUEUE_MAX) return { full: true };
  const item = { id: `q${++seq}`, text, images, ids, at: Date.now(), task: taskId };
  q.push(item);
  queues.set(session, q);
  keep(session);
  ring(session);
  start();
  return { id: item.id };
}

export function enqueueFirst(session, item) {
  queues.set(session, [item, ...(queues.get(session) || [])]);
  keep(session);
  ring(session);
  start();
}

/** Take words back before they went: the item {id, text, images, task}; null — they are gone already (or never were). */
export function takeQueued(session, id) {
  const q = queues.get(session);
  const i = q ? q.findIndex((x) => x.id === id) : -1;
  if (i < 0) return null;
  const [item] = q.splice(i, 1);
  if (!q.length) { queues.delete(session); idleSince.delete(session); }
  keep(session);
  ring(session);
  return item;
}
/** Take words back before they went; false — they are gone already (or never were). */
export const unqueue = (session, id) => Boolean(takeQueued(session, id));

/** Words marked not delivered go again (the person's «Send again»): the mark and the tries are forgotten, and they wait
    for Claude's field as new words do. False — no such words wait. */
export function sendAgain(session, id) {
  const item = (queues.get(session) || []).find((x) => x.id === id);
  if (!item) return false;
  delete item.stuck; delete item.tries; delete item.noBoxSince;
  keep(session);
  ring(session);
  start();
  return true;
}

let ticking = false; // a look at tmux can take longer than a tick: the next one waits for it, not beside it
/** One look at every session with words waiting: the first of them goes to a Claude idle long enough. */
export async function queueTick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try { await lookOnce(now); } finally { ticking = false; }
}
async function lookOnce(now) {
  for (const [session, q] of [...queues]) {
    if (!q.length) { queues.delete(session); keep(session); continue; }
    // words said not delivered wait for the person — only a terminal that is no more takes them, as it takes any queue
    if (q[0].stuck) {
      if (now - (stuckLook.get(session) || 0) < STUCK_LOOK_MS) continue;
      stuckLook.set(session, now);
      if (await deps.gone(session)) { queues.delete(session); idleSince.delete(session); stuckLook.delete(session); keep(session); ring(session); }
      continue;
    }
    let why;
    try { why = await deps.atPrompt(session); } catch { why = 'busy'; }
    if (why === 'gone' && (await deps.gone(session))) {
      queues.delete(session);
      idleSince.delete(session);
      keep(session);
      ring(session);
      continue;
    }
    // a Claude at work shows its field again: the wait for the field counts only no-box looks one after another
    if (why !== 'idle') {
      idleSince.delete(session);
      // and the base forgets it too: a restart must not bring back a wait that a busy Claude has ended
      if (q[0].noBoxSince !== undefined) { delete q[0].noBoxSince; keep(session); }
      continue;
    }
    if (!idleSince.has(session)) { idleSince.set(session, now); continue; }
    if (now - idleSince.get(session) < QUEUE_IDLE_MS || saidLately(session, now)) continue;
    const item = q.shift();
    if (!q.length) queues.delete(session);
    // out of the table before the typing, not after: a restart in the middle of it never types them twice — at most once,
    // so words whose typing a restart cut off (this one, or a «now» holding the typing lock this waits for) are lost
    keep(session);
    idleSince.delete(session); // the next words wait for this turn to be over
    const t = deps.task(item.task);
    if (!t) { ring(session); continue; } // the task was deleted meanwhile: its words go nowhere
    const r = await typing(session, () => {
      if (saidLately(session, now)) return { later: true };
      markSaid(session, now);
      return deps.say(t, session, { text: item.text, key: 'Enter', chat: true, ...(item.images.length ? { images: item.images } : {}) });
    });
    // tmux did not say whose the terminal is — nothing was typed, so no try is spent: the words wait at the head of
    // the queue for the look when tmux answers (spent, three looks of a stalled tmux threw the person's words away)
    if (r?.later || r?.refused === 'tmux-slow') { queues.set(session, [item, ...(queues.get(session) || [])]); keep(session); ring(session); continue; }
    // no field on the screen — nothing was typed either: no try is spent, the words wait for the field (a Claude redrawing
    // its screen for a new width, a view of its transcript) up to NO_BOX_HOLD_MS, then they are said not delivered
    if (r?.refused === 'no-box') {
      item.noBoxSince ??= now;
      if (now - item.noBoxSince >= NO_BOX_HOLD_MS) {
        item.stuck = 'no-box';
        logError('server', 'chat', 'queued words did not reach Claude (no-box): no input field for minutes — kept in the queue as not delivered', item.text.slice(0, 200));
      }
      queues.set(session, [item, ...(queues.get(session) || [])]);
      keep(session);
      ring(session);
      continue;
    }
    delete item.noBoxSince;
    if (r?.err) logError('server', 'chat', `queued words did not reach the terminal: ${r.err.message}`, r.text);
    // tmux failed after Enter: the words may well have reached Claude — typed again, Claude would get them twice
    if (r?.err && r.entered) {
      logError('server', 'chat', 'queued words may have reached Claude (tmux failed after Enter) — not typed again', item.text.slice(0, 200));
      ring(session);
      continue;
    }
    // another board started this terminal meanwhile (it went on with the session): the words are never typed here
    if (r?.refused === 'other-board') {
      logError('server', 'chat', `queued words were not typed: another board${r.port ? ` (port ${r.port})` : ''} started this terminal`, item.text.slice(0, 200));
      ring(session);
      continue;
    }
    // DELIVER_TRIES times; then the journal says so, and they stay at the head marked not delivered for the person
    // a refusal of tmux before Enter is a try as well — the words are not lost to it either
    if (r?.refused || r?.err) {
      item.tries = (item.tries || 0) + 1;
      if (item.tries >= DELIVER_TRIES) {
        item.stuck = r.refused || 'tmux';
        logError('server', 'chat', `queued words did not reach Claude (${item.stuck}) after ${DELIVER_TRIES} tries — kept in the queue as not delivered`, item.text.slice(0, 200));
      }
      queues.set(session, [item, ...(queues.get(session) || [])]);
      keep(session);
    }
    ring(session);
  }
  if (!queues.size) stop();
}

function start() {
  if (timer || !deps.timer) return;
  timer = setInterval(() => { queueTick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}
function stop() { clearInterval(timer); timer = null; }
/** Tests: forget everything (the kept queues too); `memory: true` — only what is in memory, as a restart of the board does. */
export function clearQueues({ memory = false } = {}) {
  queues.clear(); idleSince.clear(); saidAt.clear(); stuckLook.clear(); stop();
  if (!memory) try { db.prepare('DELETE FROM chat_queue').run(); } catch { /* no table: nothing kept */ }
}

// a check board opened from a backup (KB_PREVIEW_TTL_MS) has the base's queue too, and must never type it into a terminal
if (!isPreviewBoard()) loadQueues();
