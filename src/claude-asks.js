
import { randomUUID } from 'node:crypto';
import { db, logError, uiLang } from './db.js';
import { emit } from './bus.js';
import { SESSION_ID_RE } from './claude-sessions.js';
import { HOOK_WAIT_MS } from './claude-hooks.js';
import { sessionEvents, sessionWindows, toolSummary } from './work-feed.js';

export const POLL_HOLD_MS = 25_000;          // one long poll of the hook
export const GONE_AFTER_MS = 5_000;          // no poll for this long — the hook is gone (answered in Claude, killed)
// An answer in the first moment after a request appeared is refused: nobody has read it by then. It saves a click
// meant for something else from landing on a request that just slid in under the pointer; the card holds its
// buttons a little longer (asks.js). A program could just wait — this is not a lock, see `fromBoardPage`.
export const EARLIEST_ANSWER_MS = 500;
let pollHold = POLL_HOLD_MS;
let goneAfter = GONE_AFTER_MS;
let earliest = EARLIEST_ANSWER_MS;
/** Tests only: shorter waits. */
export function setAskTimings({ hold = POLL_HOLD_MS, gone = GONE_AFTER_MS, early = EARLIEST_ANSWER_MS } = {}) {
  pollHold = hold; goneAfter = gone; earliest = early;
}
// The three clocks run in this order, so each one ends before the next one cuts it off: the board stops offering
// the request (the card says Claude stopped waiting) → kb gives up a minute later → Claude Code would kill the
// hook a minute after that (its timeout in settings.json, HOOK_TIMEOUT_S). The other way round the card would
// keep a request whose hook is already dead.
export const ASK_LIFETIME_MS = HOOK_WAIT_MS - 60_000;
// After the hook got its answer, the answer is kept a minute more: a poll that reached the board just as its
// predecessor got the answer — the predecessor's socket died on the way — still finds it.
const ANSWER_KEEP_MS = 60_000;
const INPUT_MAX = 256 * 1024;
const TEXT_MAX = 4000;

const asks = new Map();     // id → ask
const answered = new Map(); // id → decision, for ANSWER_KEEP_MS after it went out
const ENDED_KEEP_MS = 30 * 60_000;
const ENDED_MAX = 500;
const ended = new Map(); // id → {outcome, at}
export const STARTED_AT = new Date().toISOString();
function remember(id, outcome) {
  ended.set(id, { outcome, at: Date.now() });
  const now = Date.now();
  for (const [k, v] of ended) {
    if (ended.size > ENDED_MAX || now - v.at >= ENDED_KEEP_MS) ended.delete(k);
    else break; // the rest are newer
  }
}

export function askKind(tool) {
  return tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
}

/* The task a request belongs to: the one the session is on right now (its open focus window, the same rule as
   the card's badge), else the session's latest task still in work or in review. A session the board knows
   nothing about (Claude working outside the board) gets no task, and the hook steps aside at once. */
export function taskOfSession(sid) {
  const focus = sessionWindows(sessionEvents(sid)).find((w) => w.to === null)?.task_id ?? null;
  const pick = `SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, t.status FROM tasks t JOIN projects p ON p.id = t.project_id`;
  if (focus !== null) {
    const t = db.prepare(`${pick} WHERE t.id = ? AND t.status IN ('prep','doing','deploy','review')`).get(focus);
    if (t) return t;
  }
  return db.prepare(`${pick} JOIN task_sessions s ON s.task_id = t.id
    WHERE s.session_id = ? AND t.status IN ('prep','doing','deploy','review') ORDER BY s.last_seen DESC, t.id DESC LIMIT 1`).get(sid) || null;
}

const publicShape = (a) => ({
  id: a.id, task_id: a.task_id, key: a.key, project: a.project, session_id: a.session_id, agent_id: a.agent_id,
  kind: a.kind, tool: a.tool, input: a.input, permission_mode: a.permission_mode, created_at: a.created_at,
});

/** The requests waiting for an answer — all of them, or one task's. */
export function pendingAsks(taskId = null) {
  return [...asks.values()].filter((a) => !a.decision && (taskId === null || a.task_id === taskId)).map(publicShape);
}

// Every poll still open gets the answer if there is one — not just the first: a hook whose earlier poll is not
// yet seen closed has two, and the one it reads must not be told the request is gone.
function drop(a, outcome) {
  if (!asks.has(a.id)) return;
  asks.delete(a.id);
  remember(a.id, outcome);
  clearTimeout(a.goneTimer);
  clearTimeout(a.lifeTimer);
  const last = a.decision ? { decision: a.decision } : { gone: true };
  for (const w of [...a.waiters]) w(last);
  a.waiters.clear();
  emit('ask.removed', { id: a.id, task_id: a.task_id, key: a.key, outcome });
}

// No poll running and none for GONE_AFTER_MS: Claude Code has stopped the hook (the person answered in Claude,
// the session ended). A poll that arrives later finds nothing and the hook steps aside.
function watchGone(a) {
  clearTimeout(a.goneTimer);
  a.goneTimer = setTimeout(() => { if (!a.waiters.size && Date.now() - a.lastPollEnd >= goneAfter) drop(a, 'gone'); }, goneAfter + 20);
  a.goneTimer.unref?.();
}

/** A request from the hook. Returns the public shape, `null` when the session has no task on the board, or
    `{error}` for a request that is not one. */
export function createAsk(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'a JSON object' };
  const sid = typeof body.session_id === 'string' && SESSION_ID_RE.test(body.session_id) ? body.session_id.toLowerCase() : null;
  if (!sid) return { error: 'session_id: the Claude Code session' };
  if (body.hook_event_name !== undefined && body.hook_event_name !== 'PermissionRequest') return { error: 'hook_event_name: PermissionRequest' };
  const tool = typeof body.tool_name === 'string' && /^[\w.:-]{1,200}$/.test(body.tool_name) ? body.tool_name : null;
  if (!tool) return { error: 'tool_name' };
  const input = body.tool_input === undefined ? {} : body.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'tool_input: an object' };
  if (JSON.stringify(input).length > INPUT_MAX) return { error: 'tool_input is too large' };
  const task = taskOfSession(sid);
  if (!task) return null;
  const a = {
    id: randomUUID(), task_id: task.id, key: task.key, project: task.project, session_id: sid,
    agent_id: typeof body.agent_id === 'string' ? body.agent_id.slice(0, 100) : null,
    kind: askKind(tool), tool, input,
    permission_mode: typeof body.permission_mode === 'string' ? body.permission_mode.slice(0, 40) : null,
    created_at: new Date().toISOString(), born: Date.now(),
    decision: null, waiters: new Set(), lastPollEnd: Date.now(), goneTimer: null, lifeTimer: null,
  };
  asks.set(a.id, a);
  a.lifeTimer = setTimeout(() => drop(a, 'expired'), ASK_LIFETIME_MS);
  a.lifeTimer.unref?.();
  watchGone(a);
  emit('ask.created', publicShape(a));
  return publicShape(a);
}

/** One long poll of the hook: `{decision}` once answered, `{pending: true}` after `hold` ms, `{gone: true}` when
    the request is no more. `onClose(fn)` hooks the end of the HTTP request, so a dropped poll counts as ended. */
export function waitAsk(id, { hold = pollHold, onClose = () => {} } = {}) {
  const a = asks.get(id);
  if (!a) return Promise.resolve(answered.has(id) ? { decision: answered.get(id) } : { gone: true });
  if (a.decision) { deliver(a); return Promise.resolve({ decision: a.decision }); }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.waiters.delete(finish);
      a.lastPollEnd = Date.now();
      resolve(v); // the answer goes out first: nothing after this line may hold it back
      if (v && v.decision) deliver(a);
      else if (asks.has(a.id)) watchGone(a);
    };
    const timer = setTimeout(() => finish({ pending: true }), hold);
    a.waiters.add(finish);
    onClose(() => finish({ closed: true }));
  });
}

// The answer reached the hook: take the request off the card, keep the answer for a late poll, write it into the
// task's history. The history is a record, not the delivery — a failed write is logged and changes nothing.
function deliver(a) {
  if (!asks.has(a.id)) return;
  answered.set(a.id, a.decision);
  setTimeout(() => answered.delete(a.id), ANSWER_KEEP_MS).unref?.();
  drop(a, 'decided');
  try {
    const r = db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'board', ?)").run(a.task_id, historyLine(a));
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
    const n = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(a.task_id).n;
    emit('task.comment', { task_id: a.task_id, key: a.key, project: a.project, comment: c, comments_n: n }); // local-only, no mirror
  } catch (e) {
    logError('server', 'claude-asks', `the answer to ${a.key} went to Claude, its history line was not written: ${e.message}`);
  }
}

const NOTE_MAX = 8000; // Claude Code takes a note up to 8192
const str = (v, max = TEXT_MAX) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* The person's answer → the hook's decision as Claude Code reads it (`hookSpecificOutput.decision`).
   A question is answered by echoing the questions with an `answers` map — question text → the chosen label,
   several labels of a multi-select joined by ", " — and a plan is approved by echoing its input: Claude Code
   ignores a bare allow for both. Throws a message for an answer that does not fit the request. */
export function decisionFor(a, body) {
  const behavior = body && body.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') throw new Error('behavior: allow or deny');
  const message = str(body.message);
  if (behavior === 'deny') {
    return { behavior: 'deny', message: message || (a.kind === 'plan' ? 'The plan was rejected from the board' : 'Denied from the board') };
  }
  if (a.kind === 'permission') return { behavior: 'allow' };
  if (a.kind === 'plan') return { behavior: 'allow', updatedInput: { ...a.input } };
  const questions = Array.isArray(a.input.questions) ? a.input.questions : [];
  const given = isObj(body.answers) ? body.answers : null;
  if (!given) throw new Error('answers: one answer per question');
  const answers = {};
  let annotations = null;
  // the same questions the card shows (ask-rules.js `questionsOf`): one with no text has nothing to answer
  for (const q of questions) {
    const text = isObj(q) && typeof q.question === 'string' ? q.question : null;
    if (text === null) continue;
    const v = Object.hasOwn(given, text) ? given[text] : undefined;
    const picked = (Array.isArray(v) ? v : [v]).map((x) => str(x, 1000)).filter(Boolean);
    if (!picked.length) throw new Error(`no answer to "${text.slice(0, 80)}"`);
    if (!q.multiSelect && picked.length > 1) throw new Error(`"${text.slice(0, 80)}" takes one answer`);
    answers[text] = picked.join(', ');
    const note = isObj(body.annotations) && Object.hasOwn(body.annotations, text) && isObj(body.annotations[text])
      ? str(body.annotations[text].notes, NOTE_MAX) : '';
    if (note) (annotations ||= {})[text] = { notes: note };
  }
  return { behavior: 'allow', updatedInput: { ...a.input, answers, ...(annotations ? { annotations } : {}) } };
}

/** What became of a request: `{state: 'pending'}` while it waits, `{state: 'answered'}` once the board has an answer
    the hook has not picked up yet, `{state: 'ended', outcome}` for a while after it left, null for one the board
    does not know (it was restarted since, or the request ended long ago). */
export function askFate(id) {
  const a = asks.get(id);
  if (a) return { state: a.decision ? 'answered' : 'pending' };
  const e = ended.get(id);
  return e ? { state: 'ended', outcome: e.outcome } : null;
}

// from one Claude answered in its own window ('claude'), from a wait that ran out ('expired') and from a board that
// was restarted since the request came ('unknown', with the board's start). The status codes stay as they were.
const GONE = { status: 404, error: 'the request is gone — Claude already has an answer', reason: 'claude' };
function refused(id) {
  const e = ended.get(id);
  if (!e) return { status: 404, error: 'no such request — the board was restarted since, or it ended long ago', reason: 'unknown', started_at: STARTED_AT };
  if (e.outcome === 'decided') return { status: 404, error: 'already answered from the board', reason: 'board' };
  if (e.outcome === 'expired') return { status: 404, error: 'Claude stopped waiting for an answer', reason: 'expired' };
  return GONE;
}

/** The person answered on the board. Returns {ok} or {error, status, reason}. */
export function decide(id, body) {
  const a = asks.get(id);
  if (!a) return refused(id);
  if (a.decision) return { status: 409, error: 'already answered', reason: 'board' };
  // no hook waiting and none for a while: Claude Code took the answer in its own window
  if (!a.waiters.size && Date.now() - a.lastPollEnd >= goneAfter) { drop(a, 'gone'); return GONE; }
  if (Date.now() - a.born < earliest) return { status: 425, error: 'the request has only just appeared — read it first' };
  let decision;
  try { decision = decisionFor(a, body); } catch (e) { return { status: 400, error: e.message }; }
  a.decision = decision;
  a.answer = body; // what the person chose, for the history line
  // the hook gets it now; with no poll open, its next poll does, within moments
  for (const w of [...a.waiters]) w({ decision });
  return { ok: true };
}

/* ── the history line, in the board's language ──────────────────────────────── */
const HISTORY_TEXTS = {
  ru: {
    allowed: 'Разрешено с доски', denied: 'Запрещено с доски', reason: 'причина',
    answered: 'Ответ с доски на вопрос Claude', declined: 'Вопрос Claude отклонён с доски',
    approved: 'План одобрен с доски', rejected: 'План отклонён с доски', helper: 'помощник',
    more: (n) => `ещё строк: ${n}`,
  },
  en: {
    allowed: 'Allowed from the board', denied: 'Denied from the board', reason: 'reason',
    answered: 'Answered from the board', declined: "Claude's question declined from the board",
    approved: 'Plan approved from the board', rejected: 'Plan rejected from the board', helper: 'helper',
    more: (n) => `${n} more line${n === 1 ? '' : 's'}`,
  },
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function historyLine(a) {
  const T = HISTORY_TEXTS[uiLang() === 'ru' ? 'ru' : 'en'];
  const d = a.decision;
  const who = a.agent_id ? ` (${T.helper})` : '';
  const why = d.behavior === 'deny' && str(a.answer?.message) ? ` — ${T.reason}: ${clip(str(a.answer.message), 300)}` : '';
  if (a.kind === 'question') {
    if (d.behavior === 'deny') return `${T.declined}${who}${why}`;
    const pairs = Object.entries(d.updatedInput.answers).map(([q, v]) => `«${clip(q, 120)}» — ${clip(v, 200)}`);
    return `${T.answered}${who}: ${pairs.join('; ')}`;
  }
  if (a.kind === 'plan') return d.behavior === 'allow' ? `${T.approved}${who}` : `${T.rejected}${who}${why}`;
  let what;
  if (a.tool === 'Bash') {
    // the first line of the command, and how much of it the line leaves out: the record must not pass a
    // three-line command off as its harmless first line
    const lines = String(a.input.command ?? '').trim().split('\n');
    what = clip(lines[0], 200) + (lines.length > 1 ? ` (${T.more(lines.length - 1)})` : '');
  } else what = clip(toolSummary(a.tool, a.input) || '', 200);
  return `${d.behavior === 'allow' ? T.allowed : T.denied}${who}: ${a.tool}${what ? ` · ${what}` : ''}${why}`;
}

/** Tests only: forget every request. */
export function resetAsks() {
  for (const a of [...asks.values()]) { clearTimeout(a.goneTimer); clearTimeout(a.lifeTimer); }
  asks.clear();
  answered.clear();
  ended.clear();
}
