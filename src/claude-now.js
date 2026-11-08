
import { db } from './db.js';
import { boardPaneEnded, boardPaneGone, currentBackground, currentBoardLive, currentLimited, currentOver, readRegistry, screenState, waitsPastTasks, worksPastTasks } from './claude-live.js';
import { sessionEvents, sessionWindows } from './work-feed.js';
import { WAIT_MAX_H, freshLaunchSessions, isBoardSession, waitingLaunches } from './claude-sessions.js';
import { noclaudeFilter } from './task-shape.js';
import { waitsOwnWork } from './own-wait.js';

/** How far along a task is by its stage alone — used when it has no checklist to say it better. */
export const STAGE_PERCENT = { todo: 0, prep: 25, doing: 50, ready: 65, deploy: 75, review: 100, done: 100 };
const SUBMITTED = new Set(['ready', 'review', 'done']);
const WORKING = new Set(['prep', 'doing', 'deploy']);
const STALE_H = 2; // no movement for two hours: the card's "stuck" badge and the dashboard say the same
// A task's place in its run, top to bottom: what is handed in, what Claude is on, what waits its turn.
const RANK = { review: 0, done: 0, ready: 0, focus: 1, deploy: 2, doing: 2, prep: 3, todo: 4 };

/** A task's progress in percent: its checklist when it has one, its stage otherwise. */
export function taskPercent(t) {
  if (t.checklist_n > 0) return Math.round((t.checked_n / t.checklist_n) * 100);
  return STAGE_PERCENT[t.status] ?? 0;
}

// Every task in work, plus the tasks its run has handed in or still holds in To do. A run is the latest
// session of a task (the same pick as the card's badge: the freshest `last_seen`, then the session id).
const ROWS = `
  WITH held AS (
    SELECT DISTINCT (SELECT s.session_id FROM task_sessions s WHERE s.task_id = t.id ORDER BY s.last_seen DESC, s.session_id LIMIT 1) AS session_id
    FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE t.status IN ('prep','doing','deploy') AND ${noclaudeFilter('t.')}
  ), sess AS (
    SELECT session_id FROM held WHERE session_id IS NOT NULL UNION SELECT value FROM json_each(?)
  ), cand AS (
    SELECT id FROM tasks WHERE status IN ('prep','doing','deploy')
    UNION SELECT task_id FROM task_sessions WHERE session_id IN (SELECT session_id FROM sess)
  )
  SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, p.name AS project_name,
    t.title, substr(COALESCE(t.description, ''), 1, 180) AS preview, t.status, t.blocked, t.updated_at,
    (julianday('now') - julianday(t.updated_at)) * 24 AS idle_h,
    CASE WHEN ${noclaudeFilter('t.')} THEN l.session_id END AS session_id,
    CASE WHEN ${noclaudeFilter('t.')} THEN l.first_seen END AS first_seen,
    (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id) AS checklist_n,
    (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id AND c.done = 1) AS checked_n
  FROM cand CROSS JOIN tasks t ON t.id = cand.id JOIN projects p ON p.id = t.project_id AND p.archived = 0
  LEFT JOIN task_sessions l ON l.rowid = (SELECT s.rowid FROM task_sessions s WHERE s.task_id = t.id ORDER BY s.last_seen DESC, s.session_id LIMIT 1)
  WHERE t.status IN ('prep','doing','deploy')
     OR (t.status IN ('todo','ready','review','done') AND ${noclaudeFilter('t.')}
       AND l.session_id IN (SELECT session_id FROM sess))
  ORDER BY t.id`;

const taskShape = (r, focus) => ({
  id: r.id, key: r.key, project: r.project, project_name: r.project_name, title: r.title, preview: r.preview,
  status: r.status, blocked: r.blocked ? 1 : 0, updated_at: r.updated_at,
  checklist_n: r.checklist_n, checked_n: r.checked_n, percent: taskPercent(r), focus,
  // hours without a move, only for a task still in work and only past the "stuck" mark
  stale_h: WORKING.has(r.status) && r.idle_h >= STALE_H ? Math.floor(r.idle_h) : 0,
});

function runShape({ session, claude, since, focus, rows, stale }) {
  const rank = (r) => (r.id === focus ? RANK.focus : RANK[r.status] ?? 5);
  const ordered = [...rows].sort((a, b) => (rank(a) - rank(b))
    || String(a.first_seen || '').localeCompare(String(b.first_seen || '')) || a.id - b.id);
  const tasks = ordered.map((r) => taskShape(r, r.id === focus));
  const submitted = tasks.filter((t) => SUBMITTED.has(t.status)).length;
  return {
    session, claude, since, stale,
    started_at: rows.map((r) => r.first_seen).filter(Boolean).sort()[0] || null, // the run first touched one of them
    active_at: rows.map((r) => r.updated_at).sort().at(-1) || null,              // the last move of any of them
    tasks_n: tasks.length, submitted_n: submitted,
    percent: Math.round((submitted / tasks.length) * 100),
    tasks,
  };
}

// sessions that are the latest of a task in Review, or of one in To do whose last move they made; the same `latest` as ROWS
const WAITS_ON_PERSON = `
  SELECT DISTINCT l.session_id FROM task_sessions l
  JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
  WHERE l.session_id IN (SELECT value FROM json_each(?)) AND ${noclaudeFilter('t.')}
    AND l.session_id = (SELECT x.session_id FROM task_sessions x WHERE x.task_id = l.task_id ORDER BY x.last_seen DESC, x.session_id LIMIT 1)
    AND (t.status IN ('ready', 'review') OR (t.status = 'todo'
      AND (SELECT e.session_id FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) = l.session_id))`;
/** The board's sessions that are "now" with none of their tasks in work: Map sid → 'busy' | 'background' (at work) |
    'idle' | 'waiting' (at its prompt, a task handed in to Ready to ship or Review, or put back to To do). */
export async function activeBoardSessions(isAlive, registryOf = () => readRegistry(isAlive)) {
  // the board's terminals alive by the last look of the watch (every 3 s) — not every session it ever started
  const ours = [...currentBoardLive()];
  if (!ours.length) return new Map(); // the registry is not read when no terminal of the board is alive
  const reg = await registryOf();
  const bg = currentBackground();
  const ov = currentOver();
  const out = new Map();
  const waits = new Map();
  for (const sid of ours) {
    const how = worksPastTasks(reg.get(sid), bg.has(sid), undefined, ov.has(sid));
    if (how) out.set(sid, how);
    else {
      const wait = waitsPastTasks(reg.get(sid), bg.has(sid), undefined, ov.has(sid));
      if (wait) waits.set(sid, wait);
    }
  }
  if (waits.size) {
    for (const { session_id: sid } of db.prepare(WAITS_ON_PERSON).all(JSON.stringify([...waits.keys()]))) out.set(sid, waits.get(sid));
  }
  return out;
}

export async function nowRuns(isAlive, paneOf = undefined, ownWork = waitsOwnWork) { // paneOf: boardPaneGone's own default when not given
  let reg = null;
  const registryOf = async () => (reg ||= await readRegistry(isAlive));
  const active = await activeBoardSessions(isAlive, registryOf);
  const rows = db.prepare(ROWS).all(JSON.stringify([...active.keys()]));
  const working = rows.filter((r) => WORKING.has(r.status)).length;
  if (!working && !active.size) return { runs: [], tasks_n: 0 };
  const waiting = waitingLaunches();
  const bySession = new Map(); // session → its rows
  const loose = new Map();     // `${project} ${stale}` → rows in work that no session is tied to; `… start` — ▶'s
  for (const r of rows) {
    const wait = waiting.get(r.id);
    const sid = wait === undefined ? r.session_id : null;
    const k = sid || `${r.project} ${wait !== undefined ? (wait < WAIT_MAX_H ? 'start' : 'lost') : (r.idle_h >= STALE_H ? 1 : 0)}`;
    const into = sid ? bySession : loose;
    if (!into.has(k)) into.set(k, []);
    into.get(k).push(r);
  }
  const registry = bySession.size ? await registryOf() : new Map();
  const fresh = bySession.size ? freshLaunchSessions() : new Set();
  const runs = [];
  for (const [sid, list] of bySession) {
    if (!list.some((r) => WORKING.has(r.status)) && !active.has(sid)) continue;
    const entry = registry.get(sid);
    // turn over on the screen
    let claude = screenState(entry, { bg: currentBackground().has(sid), over: currentOver().has(sid) });
    let bg = false;
    if (claude === 'background' && list.some((r) => WORKING.has(r.status)) && !(await ownWork(sid))) { claude = 'idle'; bg = true; }
    const hit = claude !== 'gone' ? currentLimited().get(sid) : undefined;
    if (hit) { claude = 'limit'; bg = false; }
    if (claude === 'gone' && fresh.has(sid) && !(await boardPaneGone(sid, paneOf))) claude = 'starting';
    // the task the session is on right now — or, for a closed one, where it stopped
    const focus = sessionWindows(sessionEvents(sid)).find((w) => w.to === null)?.task_id ?? null;
    const board = isBoardSession(sid);
    // outside, the run stays in sight with its screen, not folded among the ones nobody leads (the owner's choice); one
    const ended = claude === 'gone' && board ? await boardPaneEnded(sid, paneOf) : null;
    runs.push({ ...runShape({ session: sid, claude, since: entry?.since ?? null, focus, rows: list, stale: claude === 'gone' && !ended?.interrupted }), ...(hit ? { resets: hit.resets } : {}), ...(bg ? { background: true } : {}), ...(board ? { board: true } : {}), ...(ended ? { ended } : {}) });
  }
  for (const [k, list] of loose) {
    const lost = k.endsWith(' lost');
    const claude = k.endsWith(' start') ? 'unsent' : (lost ? 'gone' : null);
    runs.push(runShape({ session: null, claude, since: null, focus: null, rows: list, stale: lost || k.endsWith(' 1') }));
  }
  const newest = (a, b, field) => String(b[field] || '').localeCompare(String(a[field] || ''));
  runs.sort((a, b) => (a.stale - b.stale)
    || (a.stale ? newest(a, b, 'active_at') : newest(a, b, 'started_at') || newest(a, b, 'active_at')));
  return { runs, tasks_n: working };
}

export const DONE_DAYS = 7;   // how far back the section looks
export const DONE_RUNS = 30;  // and how many runs it shows at most
const LOOSE_GAP_MS = 3600000; // hand-ins without a session further apart than this are separate runs
// A session is busy while it holds a task in work on a live board — the same `held` as nowRuns; a manual task in
const DONE_ROWS = `
  WITH busy AS (
    SELECT DISTINCT (SELECT s.session_id FROM task_sessions s WHERE s.task_id = t.id ORDER BY s.last_seen DESC, s.session_id LIMIT 1) AS session_id
    FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE t.status IN ('prep','doing','deploy') AND ${noclaudeFilter('t.')}
  ), recent AS (
    SELECT DISTINCT task_id FROM task_events WHERE created_at >= @since AND status IN ('review','done')
  ), handed AS (
    SELECT DISTINCT (SELECT s.session_id FROM task_sessions s WHERE s.task_id = r.task_id ORDER BY s.last_seen DESC, s.session_id LIMIT 1) AS session_id
    FROM recent r
    WHERE COALESCE((SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = r.task_id AND x.status = 'review'),
                   (SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = r.task_id AND x.status = 'done')) >= @since
  ), rows AS (
    SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, p.name AS project_name,
      t.title, substr(COALESCE(t.description, ''), 1, 180) AS preview, t.status, t.updated_at,
      l.session_id, l.first_seen,
      (SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = t.id AND x.status = 'review') AS review_at,
      (SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = t.id AND x.status = 'done') AS done_at
    FROM handed h CROSS JOIN task_sessions l ON l.session_id = h.session_id
    JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE h.session_id IS NOT NULL
      AND l.session_id = (SELECT s.session_id FROM task_sessions s WHERE s.task_id = t.id ORDER BY s.last_seen DESC, s.session_id LIMIT 1)
      AND t.status IN ('review','done') AND ${noclaudeFilter('t.')}
      AND l.session_id NOT IN (SELECT session_id FROM busy WHERE session_id IS NOT NULL)
      AND l.session_id NOT IN (SELECT value FROM json_each(@active))
  )
  SELECT id, key, project, project_name, title, preview, status, updated_at, session_id, first_seen,
    COALESCE(review_at, done_at, updated_at) AS handed_at, done_at
  FROM rows ORDER BY id`;
// hand-ins of tasks no session is tied to, within the window
const LOOSE_ROWS = `
  WITH recent AS (
    SELECT DISTINCT task_id FROM task_events WHERE created_at >= @since AND status IN ('review','done')
  ), rows AS (
    SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, p.name AS project_name,
      t.title, substr(COALESCE(t.description, ''), 1, 180) AS preview, t.status, t.updated_at,
      (SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = t.id AND x.status = 'review') AS review_at,
      (SELECT MAX(x.created_at) FROM task_events x WHERE x.task_id = t.id AND x.status = 'done') AS done_at
    FROM recent r CROSS JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE t.status IN ('review','done') AND ${noclaudeFilter('t.')}
      AND NOT EXISTS (SELECT 1 FROM task_sessions s WHERE s.task_id = t.id)
  )
  SELECT id, key, project, project_name, title, preview, status, updated_at,
    COALESCE(review_at, done_at) AS handed_at, done_at
  FROM rows WHERE COALESCE(review_at, done_at) >= @since
  ORDER BY project, handed_at, id`;
const utcMs = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);

/** What Claude has finished lately: `{runs}`, the most recently finished first. A run is `{session, started_at,
    finished_at, tasks_n, review_n, done_n, tasks}`; a task is `{id, key, project, project_name, title, preview,
    status, handed_at, done_at}`; `session` is null for hand-ins no session is tied to (then `started_at` is its first
    hand-in). Only runs whose last hand-in is within `days`, at most `limit` of them. */
export function doneRuns({ days = DONE_DAYS, limit = DONE_RUNS, active = [] } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const bySession = new Map();
  for (const r of db.prepare(DONE_ROWS).all({ active: JSON.stringify([...active]), since })) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  // without a session: one project's hand-ins in a row, no more than an hour apart
  const loose = [];
  for (const r of db.prepare(LOOSE_ROWS).all({ since })) {
    const run = loose.at(-1);
    if (run && run[0].project === r.project && utcMs(r.handed_at) - utcMs(run.at(-1).handed_at) <= LOOSE_GAP_MS) run.push(r);
    else loose.push([r]);
  }
  const runs = [];
  for (const [session, rows] of [...bySession, ...loose.map((rows) => [null, rows])]) {
    const finished = rows.map((r) => r.handed_at).sort().at(-1);
    if (finished < since) continue;
    // in the order the run handed them in
    const tasks = [...rows].sort((a, b) => String(a.handed_at).localeCompare(String(b.handed_at)) || a.id - b.id)
      .map((r) => ({ id: r.id, key: r.key, project: r.project, project_name: r.project_name, title: r.title, preview: r.preview,
        status: r.status, handed_at: r.handed_at, done_at: r.status === 'done' ? r.done_at : null }));
    runs.push({
      session, started_at: (session ? rows.map((r) => r.first_seen) : rows.map((r) => r.handed_at)).filter(Boolean).sort()[0] || null,
      finished_at: finished,
      tasks_n: tasks.length, review_n: tasks.filter((t) => t.status === 'review').length,
      done_n: tasks.filter((t) => t.status === 'done').length, tasks,
    });
  }
  runs.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return { runs: runs.slice(0, limit) };
}
