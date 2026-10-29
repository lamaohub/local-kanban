
import { emit } from './bus.js';
import { logError } from './db.js';
import { claudeAtPrompt, phantomPane } from './phantom.js';
import { resolveTask } from './routes/tasks.js';
import { sayToTerminal } from './terminal-say.js';

export const QUEUE_IDLE_MS = 2000;  // how long Claude must have waited at its prompt before the next words go
export const QUEUE_MAX = 20;        // per session — a page that keeps sending to a stuck Claude stops here
const TICK_MS = 500;
export const DELIVER_TRIES = 3;

const queues = new Map();
const idleSince = new Map(); // session → since when it has been seen at its prompt
let seq = 0;
let timer = null;
const paneGone = async (session) => (await phantomPane(session)) === null;
const REAL = { atPrompt: claudeAtPrompt, gone: paneGone, say: sayToTerminal, task: (id) => resolveTask(String(id)), timer: true };
let deps = REAL;
/** Tests put fakes for tmux here (and `timer: false` — they tick by hand); `null` puts the real ones back. */
export function setQueueDeps(d) { deps = d ? { ...REAL, ...d } : REAL; }

const ring = (session) => emit('session.chat', { session });

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
  .map(({ id, text, images, at }) => ({ id, text, ...(images.length ? { images_n: images.length } : {}), at: new Date(at).toISOString() }));

export function enqueue(session, taskId, text, images = []) {
  const q = queues.get(session) || [];
  if (q.length >= QUEUE_MAX) return { full: true };
  const item = { id: `q${++seq}`, text, images, at: Date.now(), task: taskId };
  q.push(item);
  queues.set(session, q);
  ring(session);
  start();
  return { id: item.id };
}

export function enqueueFirst(session, item) {
  queues.set(session, [item, ...(queues.get(session) || [])]);
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
  ring(session);
  return item;
}
/** Take words back before they went; false — they are gone already (or never were). */
export const unqueue = (session, id) => Boolean(takeQueued(session, id));

let ticking = false; // a look at tmux can take longer than a tick: the next one waits for it, not beside it
/** One look at every session with words waiting: the first of them goes to a Claude idle long enough. */
export async function queueTick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try { await lookOnce(now); } finally { ticking = false; }
}
async function lookOnce(now) {
  for (const [session, q] of [...queues]) {
    if (!q.length) { queues.delete(session); continue; }
    let why;
    try { why = await deps.atPrompt(session); } catch { why = 'busy'; }
    if (why === 'gone' && (await deps.gone(session))) {
      queues.delete(session);
      idleSince.delete(session);
      ring(session);
      continue;
    }
    if (why !== 'idle') { idleSince.delete(session); continue; }
    if (!idleSince.has(session)) { idleSince.set(session, now); continue; }
    if (now - idleSince.get(session) < QUEUE_IDLE_MS || saidLately(session, now)) continue;
    const item = q.shift();
    if (!q.length) queues.delete(session);
    idleSince.delete(session); // the next words wait for this turn to be over
    const t = deps.task(item.task);
    if (!t) { ring(session); continue; } // the task was deleted meanwhile: its words go nowhere
    const r = await typing(session, () => {
      if (saidLately(session, now)) return { later: true };
      markSaid(session, now);
      return deps.say(t, session, { text: item.text, key: 'Enter', chat: true, ...(item.images.length ? { images: item.images } : {}) });
    });
    if (r?.later) { queues.set(session, [item, ...(queues.get(session) || [])]); ring(session); continue; }
    if (r?.err) logError('server', 'chat', `queued words did not reach the terminal: ${r.err.message}`, r.text);
    // DELIVER_TRIES times; then the journal says so, and they are gone
    if (r?.refused) {
      item.tries = (item.tries || 0) + 1;
      if (item.tries < DELIVER_TRIES) queues.set(session, [item, ...(queues.get(session) || [])]);
      else logError('server', 'chat', `queued words did not reach Claude (${r.refused}) after ${DELIVER_TRIES} tries`, item.text.slice(0, 200));
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
/** Tests: forget everything. */
export function clearQueues() { queues.clear(); idleSince.clear(); saidAt.clear(); stop(); }
