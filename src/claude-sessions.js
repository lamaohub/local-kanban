
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db.js';
import { claudeDir } from './config.js';

/** Claude Code session ids are UUIDs; anything else is ignored and never becomes part of a path. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOST_SESSION_RE = /^local_[A-Za-z0-9-]{1,64}$/;

// A write from a session counts as work on the task only while the task is in work or in review.
const WORK_STATUSES = new Set(['prep', 'doing', 'deploy', 'review']);

/** The session id kb sent with the request, or null. */
export function requestSession(req) {
  const v = req.headers['x-claude-session'];
  return typeof v === 'string' && SESSION_ID_RE.test(v) ? v.toLowerCase() : null;
}

/** The Claude app's own id of that session, if kb runs inside the app, or null. */
export function requestHostSession(req) {
  const v = req.headers['x-claude-host-session'];
  return typeof v === 'string' && HOST_SESSION_RE.test(v) ? v : null;
}

/** Remember that the session worked on the task; nothing happens outside the working statuses.
    `claim: false` — a note or a checkbox: a session the task already knows is refreshed, a new one is tied
    only while no other session is tied to the task since it last came into work. A word left on somebody
    else's task is not taking it over; a move of its status still is. */
export function bindSession(taskId, status, sid, host = null, { claim = true } = {}) {
  if (!sid || !WORK_STATUSES.has(status)) return;
  if (!claim && !db.prepare('SELECT 1 FROM task_sessions WHERE task_id = ? AND session_id = ?').get(taskId, sid)) {
    const work = [...WORK_STATUSES];
    const since = db.prepare(`SELECT created_at FROM task_events WHERE task_id = ? AND status NOT IN (${work.map(() => '?').join(',')})
      ORDER BY id DESC LIMIT 1`).get(taskId, ...work)?.created_at || '';
    // later than the move out of work: a note in the same second as that move is of the work before it
    if (db.prepare('SELECT 1 FROM task_sessions WHERE task_id = ? AND last_seen > ?').get(taskId, since)) return;
  }
  db.prepare(`INSERT INTO task_sessions (task_id, session_id, host_session) VALUES (?, ?, ?)
    ON CONFLICT (task_id, session_id) DO UPDATE SET last_seen = datetime('now'),
      host_session = COALESCE(excluded.host_session, task_sessions.host_session)`).run(taskId, sid, host);
}

/* ▶ moves the tasks it starts Claude on to prep at once, before that Claude has read a word, and the
   move is marked as a launch's (task_launches). A session the board named itself (inside the board, and in
   the Terminal: `claude --session-id`) signs that move and holds the task from the first second. The Claude
   app names its own session, so its move stays unsigned until the first session takes the task — and that
   one signs it (`claimLaunch`): from then on it holds the task like any session that moved it to prep. */
const LAST_PREP = `SELECT e.id, e.session_id, e.created_at, l.event_id IS NOT NULL AS launched FROM task_events e
  LEFT JOIN task_launches l ON l.event_id = e.id WHERE e.task_id = ? AND e.status = 'prep' ORDER BY e.id DESC LIMIT 1`;

/** Whether this request may move a task that is ALREADY in prep into prep again. Only the session that
    holds it: the one that moved it there, or one tied to it since (the board started it on this card,
    or it has already written to the task). Anybody else gets a refusal instead of a second claim on the
    task: two `kb take` of an older kb read To do and then move its first task, so both moved the same
    one and both were told they had it. A request without a session never holds a task. A move ▶ made
    for a Claude whose session the board could not name (the Claude app) is the first asker's.
    A request without a session on a task ▶ moved there is let through as it is — it claims nothing: it is
    the Claude ▶ started, whose `kb` sends no session id (an older one first on its PATH), confirming its
    own task as the skill tells it to; refused, it would leave the very task it was started for. `kb take`
    never gets here — it takes from To do only. */
export function mayReprep(taskId, sid) {
  const last = db.prepare(LAST_PREP).get(taskId);
  if (!sid) return Boolean(last && last.launched);
  if (last && (last.session_id === sid || (last.launched && last.session_id === null))) return true;
  return Boolean(db.prepare('SELECT 1 FROM task_sessions WHERE task_id = ? AND session_id = ? AND first_seen >= ?')
    .get(taskId, sid, last ? last.created_at : ''));
}

/** The session that holds a task in prep: the one that signed its last move there — or null (nobody's yet). */
export function prepHolder(taskId) {
  return db.prepare(LAST_PREP).get(taskId)?.session_id ?? null;
}

/** The launch's move into prep that no session has signed yet — its task_events id — or null. */
export function unclaimedLaunch(taskId) {
  const last = db.prepare(LAST_PREP).get(taskId);
  return last && last.launched && last.session_id === null ? last.id : null;
}

/** The session that takes a task ▶ started signs the launch's move: the move is its own from then on —
    the work feed cuts its transcript there, and the next session to ask is told the task is taken. */
export function claimLaunch(eventId, sid) {
  db.prepare('UPDATE task_events SET session_id = ? WHERE id = ? AND session_id IS NULL').run(sid, eventId);
}

/** Mark a move into prep as ▶'s — `via` is how Claude was started: board, terminal or desktop. */
export function markLaunch(eventId, via) {
  db.prepare('INSERT OR IGNORE INTO task_launches (event_id, via) VALUES (?, ?)').run(eventId, via);
}

/* A session ▶ started is "starting" while Claude Code's registry has not shown it alive and the start is younger
   than LAUNCH_GRACE_S; a Claude still missing after that is gone. A move the Claude app's session has not taken
   yet is "starting" until a session takes it — for at most WAIT_MAX_H, the age at which any task in work is
   "stuck" on the card and in "Claude now". */
export const LAUNCH_GRACE_S = 120;
export const WAIT_MAX_H = 2;

/** Sessions ▶ started less than LAUNCH_GRACE_S ago (inside the board, in the Terminal). */
export function freshLaunchSessions(now = Date.now()) {
  const out = new Set(db.prepare(`SELECT DISTINCT e.session_id FROM task_launches l JOIN task_events e ON e.id = l.event_id
    WHERE e.session_id IS NOT NULL AND e.created_at >= datetime('now', ?)`).all(`-${LAUNCH_GRACE_S} seconds`).map((r) => r.session_id));
  for (const [sid, at] of resumed) { if (now - at < LAUNCH_GRACE_S * 1000) out.add(sid); else resumed.delete(sid); }
  return out;
}
const resumed = new Map(); // session → when the board resumed it
export function markResumed(sid, at = Date.now()) { resumed.set(sid, at); }

/** Sessions the board named for a start in the Terminal less than LAUNCH_GRACE_S ago: they may not be in Claude Code's
    registry yet. (A session of the Claude app that signed a move has taken a task — it is up; one inside the board
    is asked of tmux.) */
export function freshTerminalSessions() {
  return new Set(db.prepare(`SELECT DISTINCT e.session_id FROM task_launches l JOIN task_events e ON e.id = l.event_id
    WHERE l.via = 'terminal' AND e.session_id IS NOT NULL AND e.created_at >= datetime('now', ?)`).all(`-${LAUNCH_GRACE_S} seconds`).map((r) => r.session_id));
}

/** Tasks in prep whose last move there was ▶'s and that no session has taken yet: task id → hours since the start. */
export function waitingLaunches() {
  const rows = db.prepare(`SELECT e.task_id, (julianday('now') - julianday(e.created_at)) * 24 AS age_h
    FROM task_launches l JOIN task_events e ON e.id = l.event_id JOIN tasks t ON t.id = e.task_id
    WHERE t.status = 'prep' AND e.session_id IS NULL
      AND e.id = (SELECT MAX(x.id) FROM task_events x WHERE x.task_id = e.task_id AND x.status = 'prep')`).all();
  return new Map(rows.map((r) => [r.task_id, r.age_h]));
}

export function tieLaunched(taskId, sid) {
  db.prepare(`INSERT INTO task_sessions (task_id, session_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)
    ON CONFLICT (task_id, session_id) DO NOTHING`).run(taskId, sid, taskId);
}

/** The board started this session itself (board_sessions): its terminal is the board's to show and to close,
    even after its tasks are deleted, and its unsigned moves are its own (work-feed.js). */
export function markBoardSession(sid) {
  db.prepare('INSERT OR IGNORE INTO board_sessions (session_id) VALUES (?)').run(sid);
}
export const isBoardSession = (sid) => Boolean(db.prepare('SELECT 1 FROM board_sessions WHERE session_id = ?').get(sid));

const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };

// A transcript that is not there yet (the session has not flushed it) or not on this machine at all
// would be searched for on every open of the card; one search a minute per session is enough.
const misses = new Map();
const MISS_TTL_MS = 60_000;

export async function findTranscript(sid, { fresh = false } = {}) {
  if (!SESSION_ID_RE.test(sid)) return null;
  const missedAt = misses.get(sid);
  if (!fresh && missedAt && Date.now() - missedAt < MISS_TTL_MS) return null;
  const root = join(claudeDir(), 'projects');
  let dirs = [];
  try { dirs = await readdir(root, { withFileTypes: true }); } catch { /* no Claude Code on this machine */ }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = join(root, d.name, `${sid}.jsonl`);
    if (await isFile(file)) { misses.delete(sid); return file; }
  }
  misses.set(sid, Date.now());
  return null;
}

/** The transcript of a task's session searched for now, past a remembered miss; found, it is kept for the task. */
export async function transcriptNow(taskId, sid) {
  const found = await findTranscript(sid, { fresh: true });
  if (found) db.prepare('UPDATE task_sessions SET transcript = ? WHERE task_id = ? AND session_id = ?').run(found, taskId, sid);
  return found;
}

/** The transcript of a session, from what its tasks keep or searched for; null — none on this machine. */
export async function sessionTranscript(sid) {
  const kept = db.prepare('SELECT transcript FROM task_sessions WHERE session_id = ? AND transcript IS NOT NULL ORDER BY last_seen DESC LIMIT 1').get(sid);
  if (kept && await isFile(kept.transcript)) return kept.transcript;
  const found = await findTranscript(sid);
  if (found) db.prepare('UPDATE task_sessions SET transcript = ? WHERE session_id = ?').run(found, sid);
  return found;
}

/** The sessions that worked on a task, oldest first, with the transcript path where it is found. */
export async function taskSessions(taskId) {
  const rows = db.prepare(`SELECT session_id, host_session, transcript, first_seen, last_seen FROM task_sessions
    WHERE task_id = ? ORDER BY first_seen, session_id`).all(taskId);
  for (const r of rows) {
    if (r.transcript && await isFile(r.transcript)) continue;
    const found = await findTranscript(r.session_id);
    if (found !== r.transcript) {
      db.prepare('UPDATE task_sessions SET transcript = ? WHERE task_id = ? AND session_id = ?').run(found, taskId, r.session_id);
      r.transcript = found;
    }
  }
  return rows;
}
