
import { stat } from 'node:fs/promises';
import { findTranscript } from './claude-sessions.js';
import { tailLines } from './own-wait.js';
import { logError, uiLang } from './db.js';
import { claudeAtPrompt, fieldEmpty } from './phantom.js';
import { markSaid, queued, saidLately, typing } from './chat-queue.js';
import { sayToTerminal } from './terminal-say.js';
import { resolveTask } from './routes/tasks.js';

export const RECOVER_TRIES = 3;
/** The pause before each «go on» of a chain: the first break is often a blink, the third a network that is down. */
export const RECOVER_PAUSES_MS = [15_000, 60_000, 180_000];
/** A «go on» typed that has not turned into a new turn in this time did not help: the person is called. */
export const SENT_WAIT_MS = 60_000;
const CHAIN_FORGET_MS = 30 * 60_000; // a break this long after the last «go on» starts a chain of its own
const STALE_MS = 6 * 3600_000;       // a chain of a session not seen for this long is dropped
// server_error that no repeat mends: the network's own certificate authority, a gateway that changes the answer
const NOT_PASSING = new Set(['tls_untrusted_ca', 'gateway_content_type']);
const TAIL_STEPS = [64 * 1024, 1024 * 1024];

const CONTINUE_TEXT = {
  ru: 'Доска: связь с API оборвалась посреди твоего ответа. Продолжай с того места, где остановился.',
  en: 'The board: the connection to the API broke off in the middle of your answer. Go on from where you stopped.',
};
/** The words the board types to its Claude after a break, in the board's language. */
export const continueText = () => CONTINUE_TEXT[uiLang() === 'en' ? 'en' : 'ru'];

/** From the raw lines of a transcript's end (oldest first): the break its conversation ends on — {uuid, at, text}; null
    — it ends on Claude's own words (a turn over as it should be); false — on words to Claude it has not answered yet (the
    person's, or the board's «go on»); undefined — no line of the conversation among them (read more). Lines Claude Code
    writes about the turn (`system` turn_duration, snapshots) do not count; words it took in the middle of a turn
    (`queued_command`) do. */
export function breakIn(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (!d || typeof d !== 'object' || d.isSidechain) continue;
    const words = d.type === 'attachment' && d.attachment?.type === 'queued_command';
    if (d.type !== 'user' && d.type !== 'assistant' && !words) continue;
    if (d.type !== 'assistant') return false;
    if (d.isApiErrorMessage !== true || d.error !== 'server_error' || NOT_PASSING.has(d.apiError)) return null;
    const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    return { uuid: String(d.uuid || d.timestamp || i), at: Date.parse(d.timestamp) || null, text: text.slice(0, 300) };
  }
  return undefined;
}

const paths = new Map(); // sid → transcript path
const seen = new Map();  // path → {size, mtime, result}
/** The break the conversation of session `sid` ends on now — as breakIn; false when its transcript is not found or not
    read. Read only on a change of the transcript. */
export async function breakNow(sid) {
  let path = paths.get(sid);
  if (!path) {
    path = await findTranscript(sid);
    if (!path) return false;
    paths.set(sid, path);
  }
  let st;
  try { st = await stat(path); } catch { paths.delete(sid); return false; }
  let hit = seen.get(path);
  if (!hit || hit.size !== st.size || hit.mtime !== st.mtimeMs) {
    let result = false;
    try {
      for (const bytes of TAIL_STEPS) {
        const r = breakIn(await tailLines(path, st.size, bytes));
        if (r !== undefined) { result = r; break; }
        if (bytes >= st.size) break;
      }
    } catch { /* unreadable: no break */ }
    hit = { size: st.size, mtime: st.mtimeMs, result };
    seen.set(path, hit);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
  }
  return hit.result;
}

/* ── what the board does about a break ─────────────────────────────────────────── */
const chains = new Map(); // sid → {uuid, task, board, tries, due, at, sent, sentAt, failed, stuck}
const pauseOf = (tries) => RECOVER_PAUSES_MS[Math.min(tries, RECOVER_PAUSES_MS.length - 1)];

/** What the board does about the break `brk` its session `sid` (on task `task`) ends on: 'retrying' — it tells its
    Claude to go on; 'stuck' — the person is needed. `board` — the board started this Claude (it can type to it). */
export function breakState(sid, brk, { board, task }, now = Date.now()) {
  let c = chains.get(sid);
  if (!c || c.uuid !== brk.uuid) {
    // a break right after the board's own «go on» goes on the same chain (its tries with it); a break after the person
    // was called can only follow their words — it starts anew
    const goesOn = Boolean(c?.sent) && !c.stuck && now - c.sentAt < CHAIN_FORGET_MS;
    const tries = goesOn ? c.tries : 0;
    // review: chains live in memory — after a restart of the board an old break, gone through its tries long ago, would
    // be typed to again (and rung again) on every restart; one older than this is the person's already
    const old = Boolean(brk.at) && now - brk.at > CHAIN_FORGET_MS;
    c = { uuid: brk.uuid, task, board: Boolean(board), tries, due: now + pauseOf(tries), at: now, sent: false, sentAt: 0, failed: old, stuck: false };
    chains.set(sid, c);
  }
  c.at = now;
  // review: a «go on» that never got typed (its Claude out of the board's terminal, a question on the screen, a board
  // that never acts — the preview of a backup) does not keep the card «going on» for good: past its time it is the person's
  const st = !c.board || c.failed ? 'stuck'
    : c.sent ? (now - c.sentAt < SENT_WAIT_MS ? 'retrying' : 'stuck')
      : c.tries < RECOVER_TRIES && now - c.due < SENT_WAIT_MS ? 'retrying' : 'stuck';
  if (st === 'stuck') c.stuck = true;
  return st;
}
/** Session `sid` ended a turn as it should: the chain of its breaks is over. */
export function settleBreak(sid) { chains.delete(sid); }

// wrapped, not taken at load: this module sits in an import cycle (claude-live ↔ phantom, chat-queue), and a `const`
// export of a module still loading is not there yet («Cannot access 'queued' before initialization»)
const REAL = {
  atPrompt: (sid) => claudeAtPrompt(sid), fieldEmpty: (sid) => fieldEmpty(sid), queued: (sid) => queued(sid), breakNow: (sid) => breakNow(sid),
  say: (...a) => sayToTerminal(...a), task: (id) => resolveTask(String(id)),
};
let deps = REAL;
/** Tests put fakes for tmux here; `null` puts the real ones back. */
export function setBreakDeps(d) { deps = d ? { ...REAL, ...d } : REAL; }
/** Tests: the chain of a session as it stands. */
export const breakChain = (sid) => chains.get(sid);
/** Tests: forget every chain. */
export function clearBreaks() { chains.clear(); paths.clear(); seen.clear(); }

let acting = false;
/** Tell every Claude of the board whose pause after a break is over to go on — one look at a time. */
export async function recoverDue(now = Date.now()) {
  if (acting) return;
  acting = true;
  try {
    for (const [sid, c] of [...chains]) {
      if (now - c.at > STALE_MS) { chains.delete(sid); continue; }
      if (!c.board || c.sent || c.failed || c.stuck || c.tries >= RECOVER_TRIES || now < c.due) continue;
      await goOn(sid, c, now);
    }
  } finally { acting = false; }
}

const WORK = new Set(['prep', 'doing', 'deploy']);
async function goOn(sid, c, now) {
  const t = deps.task(c.task);
  // review: the person took the task out of work in the pause — typing would move it back (sayToTerminal); not ours
  if (!t || !WORK.has(t.status)) { chains.delete(sid); return; }
  let r;
  try {
    // person may go between a look and the typing
    r = await typing(sid, async () => {
      if (saidLately(sid, now) || deps.queued(sid).length) return { later: true }; // the person's words answer the break
      const brk = await deps.breakNow(sid);
      if (!brk || brk.uuid !== c.uuid) return { gone: true }; // it is no longer the last word: someone spoke since
      if ((await deps.atPrompt(sid)) !== 'idle') return { later: true }; // busy again, or a question: the next look
      const empty = await deps.fieldEmpty(sid);
      if (empty === null) return { later: true }; // tmux did not answer: the next look
      if (!empty) return { typedThere: true };
      c.sent = true;
      c.sentAt = now;
      c.tries += 1;
      markSaid(sid, now);
      const said = await deps.say(t, sid, { text: continueText(), chat: true });
      markSaid(sid); // and at the end: delivery checked on the screen takes seconds, the queue's next words wait theirs
      return said;
    });
  } catch (e) {
    r = { err: e };
  }
  if (r?.later) return;
  if (r?.gone) { chains.delete(sid); return; }
  // something typed in its field is the person at work there: the board does not wipe it — it calls them
  if (r?.typedThere) { c.failed = true; return; }
  if (r?.refused || r?.err) {
    c.failed = true;
    logError('server', 'claude', `«go on» after a broken connection did not reach Claude (${r.refused || r.err?.message})`, sid);
  }
}
