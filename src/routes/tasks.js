import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, STATUSES, WORK_SEGMENT_MAX_S, enqueue, nextTaskNo, nextPosition, logError } from '../db.js';
import { scalarQuery } from '../query-params.js';
import { bus, emit } from '../bus.js';
import { resolveProject } from './projects.js';
import { kick } from '../sync/worker.js';
import { LABELS } from '../sync/github.js';
import { repoHttpsBase } from '../repo-base.js';
import { isManual, listShape, noclaudeFilter, snapshot, taskEvent } from '../task-shape.js';
import { requestSession, requestHostSession, bindSession, taskSessions, mayReprep, unclaimedLaunch, claimLaunch, markLaunch } from '../claude-sessions.js';
import { taskFeed } from '../work-feed.js';
import { taskUsage } from '../claude-usage.js';
import { currentWorkProjects, liveTasks, terminalQuestions } from '../claude-live.js';
import { activeBoardSessions, doneRuns, nowRuns } from '../claude-now.js';
import { closeFinishedTerminals, taskTerminal } from '../phantom.js';
import { CHECK_LABEL, OPEN_CHECK, isCheck, leadCheck, openCheck, secondCheck } from '../review-check.js';
import { treePrint } from '../tree-print.js';

const ATTACH_DIR = join(DATA_DIR, 'attachments');
const ATTACH_MAX = 30;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function taskAttachments(id) {
  return db.prepare("SELECT id, file, mime, created_at FROM task_attachments WHERE task_id = ? AND file != '' ORDER BY id").all(id)
    .map((a) => ({ ...a, url: `/attachments/${id}/${a.file}`, path: join(ATTACH_DIR, String(id), a.file) }));
}

export function taskAttachmentPaths(taskId, ids) {
  const get = db.prepare("SELECT file FROM task_attachments WHERE id = ? AND task_id = ? AND file != ''");
  const out = [];
  for (const id of ids) {
    const a = get.get(id, taskId);
    if (!a) return null;
    out.push(join(ATTACH_DIR, String(taskId), a.file));
  }
  return out;
}

const commentsN = (id) => db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n;
const attachmentsN = (id) => db.prepare("SELECT COUNT(*) AS n FROM task_attachments WHERE task_id = ? AND file != ''").get(id).n;
const linkedIds = (id) => db.prepare('SELECT linked_task_id AS o FROM task_links WHERE task_id = ? UNION SELECT task_id FROM task_links WHERE linked_task_id = ?').all(id, id).map((r) => r.o);

function taskChecklist(id) {
  return db.prepare('SELECT id, text, done, position FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(id)
    .map((c) => ({ ...c, done: !!c.done }));
}
function checklistEvent(t, { textOnly = false } = {}) {
  const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(done), 0) AS d FROM task_checklist WHERE task_id = ?').get(t.id);
  emit('task.checklist', { task_id: t.id, key: t.key, project: t.project, checklist_n: c.n, checked_n: c.d, checklist: taskChecklist(t.id), ...(textOnly ? { text_only: true } : {}) });
}

async function commitUrlFor(task) {
  const c = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'git' ORDER BY id DESC LIMIT 1").get(task.id);
  const hash = (c?.body || '').trim().split(/\s/)[0];
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return null;
  const proj = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id);
  const base = await repoHttpsBase(proj?.path);
  return base ? `${base}/commit/${hash}` : null;
}

function attachGitStat(task, startedAt) {
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id);
  if (!project?.path) return;
  const issueNo = task.gh_issue_number;
  let args, gate = null;
  if (issueNo) {
    args = ['-C', project.path, 'log', '-1', '-E', `--grep=#${issueNo}([^0-9]|$)`, '--format=%h|%ct|%s', '--shortstat'];
  } else if (startedAt) {
    args = ['-C', project.path, 'log', '-1', '--format=%h|%ct|%s', '--shortstat'];
    gate = startedAt;
  } else {
    return;
  }
  execFile('git', args, { timeout: 5000 }, (err, stdout) => {
    try {
      if (err) return;
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) return;
      const [hash, ct, ...subj] = (lines[0] || '').split('|');
      if (!hash || !ct) return;
      if (gate && Number(ct) < Math.floor(new Date(gate + 'Z').getTime() / 1000)) return;
      if (db.prepare("SELECT 1 FROM task_comments WHERE task_id = ? AND author = 'git' AND body LIKE ?").get(task.id, hash + ' %')) return;
      const stat = lines[1] ? lines[1].trim() : '';
      const body = `${hash} ${subj.join('|')}${stat ? `\n${stat}` : ''}`;
      const r = db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'git', ?)").run(task.id, body);
      const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
      emit('task.comment', { task_id: task.id, key: task.key, project: task.project, comment: c, comments_n: commentsN(task.id) });
    } catch (e) {
      logError('server', 'attachGitStat', e?.message || String(e), `task #${task.id}`);
    }
  });
}

export const TASK_SELECT = `
  SELECT t.*, p.slug AS project, (p.prefix || '-' || t.task_no) AS key
  FROM tasks t JOIN projects p ON p.id = t.project_id
`;

export function resolveTask(idOrKey) {
  if (/^\d+$/.test(idOrKey)) return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(idOrKey);
  const m = String(idOrKey).match(/^([a-z0-9]+)-(\d+)$/i);
  if (!m) return null;
  const t = db.prepare(`${TASK_SELECT} WHERE upper(p.prefix) = upper(?) AND t.task_no = ?`).get(m[1], m[2]);
  if (t) return t;
  return db.prepare(`${TASK_SELECT} WHERE t.id = (SELECT mv.task_id FROM task_moves mv JOIN projects mp ON mp.id = mv.project_id
    WHERE upper(mp.prefix) = upper(?) AND mv.task_no = ?)`).get(m[1], m[2]);
}

export { snapshot };

function taskLinks(id) {
  return db.prepare(`
    SELECT t.id, (p.prefix || '-' || t.task_no) AS key, t.title, t.status,
      CASE WHEN l.kind = 'parent' AND l.task_id = @id THEN 'child'
           WHEN l.kind = 'parent' AND l.linked_task_id = @id THEN 'parent'
           ELSE 'related' END AS rel
    FROM task_links l
    JOIN tasks t ON t.id = CASE WHEN l.task_id = @id THEN l.linked_task_id ELSE l.task_id END
    JOIN projects p ON p.id = t.project_id
    WHERE l.task_id = @id OR l.linked_task_id = @id
    ORDER BY rel, t.id
  `).all({ id });
}

function removeLinkPair(a, b) {
  db.prepare('DELETE FROM task_links WHERE (task_id = ? AND linked_task_id = ?) OR (task_id = ? AND linked_task_id = ?)')
    .run(a, b, b, a);
}

function placeAdjacent(a, b) {
  if (a.status !== b.status || a.project_id !== b.project_id) return;
  const next = db.prepare('SELECT MIN(position) AS p FROM tasks WHERE status=? AND project_id=? AND position > ? AND id != ?')
    .get(a.status, a.project_id, a.position, b.id);
  const newPos = next && next.p != null ? (a.position + next.p) / 2 : a.position + 1;
  db.prepare("UPDATE tasks SET position = ?, updated_at = datetime('now') WHERE id = ?").run(newPos, b.id);
}

function badText(v, name) {
  if (v === undefined || v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return null;
  return `${name}: expected a string`;
}

function normalizeLabels(v) {
  if (!Array.isArray(v)) return null;
  return v.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim());
}

function unknownLabels(arr) {
  return arr.filter((l) => !Object.prototype.hasOwnProperty.call(LABELS, l));
}
function labelPaletteError(bad) {
  return { error: `unknown labels: ${bad.join(', ')} — they are not in the palette and the GitHub sync would fail. Allowed: ${Object.keys(LABELS).join(', ')}` };
}

async function fullTask(t) {
  const events = db.prepare('SELECT e.status, e.created_at, m.kind AS typed FROM task_events e LEFT JOIN typed_moves m ON m.event_id = e.id WHERE e.task_id = ? ORDER BY e.id').all(t.id);
  const moves = db.prepare(`SELECT (mp.prefix || '-' || mv.task_no) AS key, mv.moved_at FROM task_moves mv JOIN projects mp ON mp.id = mv.project_id
    WHERE mv.task_id = ? ORDER BY mv.moved_at, mv.rowid`).all(t.id);
  return { ...t, labels: JSON.parse(t.labels || '[]'), events, moves, links: taskLinks(t.id), attachments: taskAttachments(t.id), checklist: taskChecklist(t.id), commit_url: await commitUrlFor(t), sessions: await taskSessions(t.id), usage: await taskUsage(t.id), terminal: await taskTerminal(t.id) };
}

function planPatch(t, b, sid = null) {
  const updates = [];
  const values = [];
  let claim = null;
  const bad = (error) => ({ code: 400, error });
  for (const f of ['title', 'description', 'blocked_reason']) { const e = badText(b[f], f); if (e) return bad(e); }

  if (b.title !== undefined) { updates.push('title = ?'); values.push(String(b.title ?? '')); }
  if (b.description !== undefined) { updates.push('description = ?'); values.push(String(b.description ?? '')); }
  if (b.priority !== undefined) {
    if (!Number.isInteger(b.priority) || b.priority < 0 || b.priority > 3) return bad('priority: an integer 0-3');
    updates.push('priority = ?'); values.push(b.priority);
  }
  let labels = null;
  const delta = b.labels_add !== undefined || b.labels_remove !== undefined;
  if (b.labels !== undefined && delta) return bad('labels replaces the whole set, labels_add/labels_remove change it — send one or the other');
  if (b.labels !== undefined) {
    labels = normalizeLabels(b.labels);
    if (labels === null) return bad('labels: an array of strings');
    const badSet = unknownLabels(labels);
    if (badSet.length) return { code: 400, ...labelPaletteError(badSet) };
  } else if (delta) {
    const add = b.labels_add === undefined ? [] : normalizeLabels(b.labels_add);
    const remove = b.labels_remove === undefined ? [] : normalizeLabels(b.labels_remove);
    if (add === null) return bad('labels_add: an array of strings');
    if (remove === null) return bad('labels_remove: an array of strings');
    const badAdd = unknownLabels(add);
    if (badAdd.length) return { code: 400, ...labelPaletteError(badAdd) };
    const cur = JSON.parse(t.labels || '[]');
    const next = [...new Set([...cur, ...add])].filter((l) => !remove.includes(l));
    if (JSON.stringify(next) !== JSON.stringify(cur)) labels = next;
  }
  if (labels) { updates.push('labels = ?'); values.push(JSON.stringify(labels)); }
  if (b.blocked !== undefined) {
    updates.push('blocked = ?'); values.push(b.blocked ? 1 : 0);
    updates.push('blocked_reason = ?'); values.push(b.blocked ? String(b.blocked_reason ?? '') : null);
  }
  if (b.position !== undefined) {
    if (typeof b.position !== 'number' && typeof b.position !== 'string') return bad('position: a finite number');
    const pos = Number(b.position);
    if (!Number.isFinite(pos)) return bad('position: a finite number');
    updates.push('position = ?'); values.push(pos);
  }
  if (b.pinned !== undefined) { updates.push('pinned = ?'); values.push(b.pinned ? 1 : 0); }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad('bad status');
    if (b.status === 'prep' && t.status === 'prep') {
      if (!mayReprep(t.id, sid)) return { code: 409, error: `${t.key} is already taken: it is in prep. To take a free task: kb take ${t.project}` };
      claim = unclaimedLaunch(t.id);
    }
    if (!isManual(labels || t.labels) && ['backlog', 'todo'].includes(t.status) && ['review', 'done'].includes(b.status)) {
      return bad(`cannot go straight from "${t.status}" to "${b.status}" — it has to pass through the working statuses`);
    }
    updates.push('status = ?'); values.push(b.status);
    if (b.status === 'done' && t.status !== 'done') updates.push("done_at = datetime('now')");
    else if (b.status !== 'done' && t.status === 'done') updates.push('done_at = NULL');
    const working = (s) => s === 'doing' || s === 'deploy';
    // again (`kb mv <key> doing`) starts it anew
    if (working(b.status) && (!working(t.status) || !t.work_started_at)) {
      updates.push("work_started_at = datetime('now')");
    } else if (!working(b.status) && working(t.status)) {
      updates.push("work_seconds = work_seconds + MIN(?, MAX(0, COALESCE(CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', work_started_at) AS INTEGER), 0)))");
      values.push(WORK_SEGMENT_MAX_S);
      updates.push("work_truncated = work_truncated + (COALESCE(CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', work_started_at) AS INTEGER), 0) > ?)");
      values.push(WORK_SEGMENT_MAX_S);
      updates.push('work_started_at = NULL');
    }
    if (b.status !== t.status && b.position === undefined) {
      updates.push('position = ?'); values.push(nextPosition(t.project_id, b.status));
    }
  }
  return { updates, values, labels, claim };
}

function commitPatch(t, b, { updates, values, labels, claim }, sid, host, launch = null, typed = null) {
  db.prepare(`UPDATE tasks SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, t.id);
  const f = resolveTask(String(t.id));

  if (b.title !== undefined || b.description !== undefined) enqueue('update_issue', f.id, snapshot(f));
  if (b.priority !== undefined && b.priority !== t.priority) enqueue('set_priority', f.id, snapshot(f));
  if (labels) enqueue('set_labels', f.id, snapshot(f));
  if (b.blocked !== undefined && (b.blocked ? 1 : 0) !== t.blocked) enqueue('set_blocked', f.id, snapshot(f));
  if (b.status !== undefined && b.status !== t.status) {
    const ev = db.prepare('INSERT INTO task_events (task_id, status, session_id) VALUES (?, ?, ?)').run(t.id, b.status, sid);
    if (launch) markLaunch(ev.lastInsertRowid, launch);
    if (typed) db.prepare('INSERT INTO typed_moves (event_id, kind) VALUES (?, ?)').run(ev.lastInsertRowid, typed);
    const closed = (s) => s === 'done' || s === 'cancelled';
    if (closed(b.status)) enqueue('close_issue', f.id, snapshot(f));
    else if (closed(t.status)) enqueue('reopen_issue', f.id, snapshot(f));
    else enqueue('set_status', f.id, snapshot(f));
  }
  if (claim && sid) claimLaunch(claim, sid);
  bindSession(t.id, f.status, sid, host);
  return f;
}

function afterPatch(t, b, fresh, { sid = null, undo = false } = {}) {
  const statusChanged = b.status !== undefined && b.status !== t.status;
  if (statusChanged && b.status === 'review' && !undo) {
    attachGitStat(fresh, t.work_started_at || db.prepare("SELECT created_at FROM task_events WHERE task_id = ? AND status = 'doing' ORDER BY id DESC LIMIT 1").get(t.id)?.created_at);
  }
  kick();
  if (statusChanged && (b.status === 'done' || b.status === 'cancelled')) closeFinishedTerminals().catch(() => {});
  emit('task.updated', { ...taskEvent(fresh.id), prev_status: t.status });
  if (statusChanged && !WORK_IN.has(t.status) && WORK_IN.has(b.status)) settleTyped(sid, t.id);
}

export function moveLaunched(tasks, sid, via) {
  return moveFrom(tasks, ['backlog', 'todo'], 'prep', sid, via);
}

export function moveTyped(t, sid) {
  if (isCheck(t) && openCheck(t.project_id, t.id)) return { prep: [], doing: [] };
  const before = resolveTask(String(t.id));
  const prep = moveFrom([t], ['backlog', 'todo'], 'prep', sid, null, 'typed');
  const doing = moveFrom([t], ['review'], 'doing', sid, null, 'typed');
  if (doing.length && sid) {
    const print = treePrint(db.prepare('SELECT path FROM projects WHERE id = ?').get(t.project_id)?.path);
    holdTyped(t.id, { sid, event: lastEvent(t.id).id, at: Date.now(), seconds: before.work_seconds, truncated: before.work_truncated, print });
  }
  return { prep, doing };
}

const typedBack = new Map(); // task id → { sid, event, at, seconds, truncated, print }: moved from Review to doing by typed words
function holdTyped(id, m) {
  typedBack.set(id, m);
  db.prepare('INSERT OR REPLACE INTO typed_backs (task_id, session_id, event_id, at_ms, seconds, truncated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, m.sid, m.event, m.at, m.seconds || 0, m.truncated || 0);
  Promise.resolve(m.print).then((print) => {
    if (typedBack.get(id) === m) db.prepare('UPDATE typed_backs SET print = ?, printed = 1 WHERE task_id = ?').run(print ?? null, id);
  }).catch(() => {});
}
function dropTyped(id) {
  typedBack.delete(id);
  db.prepare('DELETE FROM typed_backs WHERE task_id = ?').run(id);
}
for (const r of db.prepare('SELECT * FROM typed_backs').all()) {
  typedBack.set(r.task_id, { sid: r.session_id, event: r.event_id, at: r.at_ms, seconds: r.seconds, truncated: r.truncated, print: Promise.resolve(r.printed ? r.print : null) });
}
const WORK_IN = new Set(['prep', 'doing', 'deploy']); // a move into one of these from elsewhere is taking a task into work
let SETTLE_MS = 5 * 60 * 1000;
/** Tests: how long typed words wait for the session's next task. */
export function setSettleMs(ms) { SETTLE_MS = ms; }
const lastEvent = (taskId) => db.prepare('SELECT id, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);

/** Whether task `id` is as move `e` of the words left it: no move since, and no comment, checklist or edit of session
    `sid` after it (task_sessions.last_seen, bindSession). */
function untouched(id, sid, e) {
  const last = lastEvent(id);
  if (!last || last.id !== e.id) return false; // moved since: not ours to undo
  const seen = db.prepare('SELECT last_seen FROM task_sessions WHERE task_id = ? AND session_id = ?').get(id, sid)?.last_seen;
  return !(seen && seen > e.created_at);
}

/** Session `sid` took task `id` into work: the tasks its typed words sent from Review to doing in the last SETTLE_MS,
    untouched by it since, go back to Review. Returns the keys moved. Older words wait for the end of the turn
    (settleTurns). */
function settleTyped(sid, id) {
  const back = [];
  for (const [taskId, m] of typedBack) {
    if (!sid || m.sid !== sid || taskId === id || Date.now() - m.at > SETTLE_MS) continue;
    dropTyped(taskId);
    const e = db.prepare('SELECT id, created_at FROM task_events WHERE id = ?').get(m.event);
    if (e && untouched(taskId, sid, e)) back.push({ id: taskId, ...m });
  }
  return undoTyped(back);
}

/** The live states of the tasks in work (claude-live.js, `task.live`): tasks moved by typed words whose turn is over
    go back to Review when the turn left them untouched. Returns the keys moved. */
export async function settleTurns(states) {
  for (const [taskId, m] of typedBack) if (lastEvent(taskId)?.id !== m.event) dropTyped(taskId); // moved since
  const back = [];
  for (const st of states || []) {
    const m = typedBack.get(st.id);
    if (!m) continue;
    const e = db.prepare('SELECT id, created_at FROM task_events WHERE id = ?').get(m.event);
    if (!e || !untouched(st.id, m.sid, e)) { dropTyped(st.id); continue; }
    // the turn the words started: Claude idle again, and since after them (the registry dates a change of its state)
    if (st.status !== 'doing' || st.claude !== 'idle' || !(st.since > m.at)) continue;
    dropTyped(st.id);
    // the files it changed are that task's; otherwise a commit or a changed file says they were about this one
    const elsewhere = db.prepare('SELECT 1 FROM task_events WHERE session_id = ? AND task_id != ? AND id > ? LIMIT 1').get(m.sid, st.id, m.event);
    if (!elsewhere) {
      const before = await m.print;
      const now = await treePrint(db.prepare('SELECT p.path FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(st.id)?.path);
      if (before === null || now === null || before !== now) continue; // committed or changed files — or cannot tell
    }
    back.push({ id: st.id, ...m });
  }
  return undoTyped(back);
}
bus.on('event', (ev) => { if (ev?.type === 'task.live') settleTurns(ev.data?.tasks).catch(() => {}); });

/** Send the tasks typed words moved back to Review: each with the time it had, unsigned (see above). */
function undoTyped(back) {
  if (!back.length) return [];
  const b = { status: 'review' };
  const moved = db.transaction(() => {
    const out = [];
    for (const m of back) {
      const t = resolveTask(String(m.id));
      if (!t || t.status !== 'doing') continue;
      const e = db.prepare('SELECT id, created_at FROM task_events WHERE id = ?').get(m.event);
      if (!e || !untouched(t.id, m.sid, e)) continue; // read again: an await may have let a move in
      const plan = planPatch(t, b, m.sid);
      if (plan.error) continue;
      commitPatch(t, b, plan, m.sid, null, null, 'settled');
      db.prepare("UPDATE typed_moves SET kind = 'typed-undone' WHERE event_id = ?").run(m.event);
      // the minutes it spent in doing were the other task's
      db.prepare('UPDATE tasks SET work_seconds = ?, work_truncated = ? WHERE id = ?').run(m.seconds, m.truncated, t.id);
      // review: and so was the session's attention — signed, the words and their undoing held the focus on this task, and
      // the other one, taken to prep meanwhile as a batch, never got it: no «working» on its card or in Claude now
      db.prepare('UPDATE task_events SET session_id = NULL WHERE task_id = ? AND id >= ?').run(t.id, m.event);
      out.push({ t, fresh: resolveTask(String(t.id)) });
    }
    return out;
  })();
  for (const m of moved) afterPatch(m.t, b, m.fresh, { undo: true });
  return moved.map((m) => m.t.key);
}

/** The tasks that are in one of `from` now go to `status`, as a move of `sid` (see moveLaunched). Returns the keys moved. */
function moveFrom(tasks, from, status, sid, via, typed = null) {
  const b = { status };
  const moved = db.transaction(() => {
    const out = [];
    for (const one of tasks) {
      const t = resolveTask(String(one.id)); // read again: it may have moved while Claude was being started
      if (!t || !from.includes(t.status)) continue;
      const plan = planPatch(t, b, sid);
      if (plan.error) continue;
      out.push({ t, fresh: commitPatch(t, b, plan, sid, null, via, typed) });
    }
    return out;
  })();
  for (const m of moved) afterPatch(m.t, b, m.fresh, { sid });
  return moved.map((m) => m.t.key);
}

const lowered = new Map();
bus.on('event', (ev) => { if (ev?.type === 'task.updated' || ev?.type === 'task.deleted') lowered.delete(ev.data?.id); });

/** Ids of the tasks under `where` whose title, description, key or labels hold `q`, in any case. */
function searchIds(where, args, q) {
  const ql = q.toLowerCase();
  const rows = db.prepare(`SELECT t.id, t.updated_at AS at, length(t.title) AS lt, length(t.description) AS ld, length(t.labels) AS ll,
      (p.prefix || '-' || t.task_no) AS key, t.status IN ('done', 'cancelled') AS closed
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE 1=1${where}`).all(...args);
  const stale = new Map();
  for (const r of rows) {
    const c = lowered.get(r.id);
    if (!c || c.at !== r.at || c.lt !== r.lt || c.ld !== r.ld || c.ll !== r.ll) stale.set(r.id, r);
  }
  if (stale.size) {
    const texts = db.prepare('SELECT id, title, description, labels FROM tasks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...stale.keys()]));
    for (const t of texts) {
      const r = stale.get(t.id);
      lowered.set(t.id, { at: r.at, lt: r.lt, ld: r.ld, ll: r.ll, title: t.title.toLowerCase(), description: t.description.toLowerCase(), labels: t.labels.toLowerCase() });
    }
  }
  return rows.filter((r) => {
    const c = lowered.get(r.id);
    return c && (c.title.includes(ql) || c.description.includes(ql) || r.key.toLowerCase().includes(ql) || c.labels.includes(ql));
  }).sort((a, b) => (a.closed - b.closed) || String(b.at || '').localeCompare(String(a.at || '')) || (b.id - a.id)).map((r) => r.id);
}

export const SEARCH_MAX = 200;

export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export default async function taskRoutes(app) {
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES }, (req, body, done) => done(null, body));

  app.get('/api/tasks', (req, reply) => {
    const parsed = scalarQuery(req.query, ['project', 'status', 'all', 'q', 'limit']);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });
    const { project, status, all, q, limit } = parsed.values;
    // without it (its cards are the answer, a cut list would hide a task that is there)
    const cap = limit === undefined ? Infinity : Number(limit);
    if (!(Number.isInteger(cap) && cap > 0) && cap !== Infinity) return reply.code(400).send({ error: 'limit: a whole number from 1' });
    const p = project ? resolveProject(project) : null;
    if (project && !p) return reply.code(404).send({ error: 'project not found' });
    let where = '';
    const args = [];
    if (p) { where += ' AND t.project_id = ?'; args.push(p.id); }
    else where += ' AND p.archived = 0';
    if (status) { where += ' AND t.status = ?'; args.push(status); }
    else if (!all) where += " AND t.status NOT IN ('done','cancelled','backlog')";
    if (q) {
      // changed first (as the search window orders them) — a common word sent the whole board, 1.7 MB a request
      const found = searchIds(where, args, q).slice(0, cap === Infinity ? undefined : Math.min(cap, SEARCH_MAX));
      where += ' AND t.id IN (SELECT value FROM json_each(?))';
      args.push(JSON.stringify(found));
    }
    const sql = `
      SELECT t.id, t.project_id, t.task_no, t.title, substr(t.description, 1, 180) AS description,
        t.status, t.priority, t.blocked, t.blocked_reason, t.position, t.pinned,
        t.work_seconds, t.work_started_at, t.work_truncated,
        t.gh_issue_number, t.gh_issue_url, t.updated_at, t.labels,
        p.slug AS project, (p.prefix || '-' || t.task_no) AS key,
        (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_n,
        (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = t.id AND a.file != '') AS attachments_n
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE 1=1${where}
      ORDER BY t.status, t.priority DESC, t.position, t.id`;
    const list = db.prepare(sql).all(...args).map(listShape);
    const linkMap = {};
    const linkRows = list.length
      ? db.prepare(`WITH shown(id) AS (SELECT value FROM json_each(?))
                    SELECT task_id, linked_task_id FROM task_links
                    WHERE task_id IN shown OR linked_task_id IN shown`).all(JSON.stringify(list.map((t) => t.id)))
      : [];
    for (const { task_id, linked_task_id } of linkRows) {
      (linkMap[task_id] ||= []).push(linked_task_id);
      (linkMap[linked_task_id] ||= []).push(task_id);
    }
    for (const t of list) t.linked_ids = linkMap[t.id] || [];
    return list;
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return fullTask(t);
  });

  app.get('/api/live', async () => ({ tasks: await liveTasks(), questions: await terminalQuestions(), projects: currentWorkProjects() }));

  app.get('/api/now', async () => nowRuns());

  app.get('/api/done', async () => doneRuns({ active: [...(await activeBoardSessions()).keys()] }));

  app.get('/api/tasks/:id/work', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return taskFeed(t.id, { count: req.query.count === '1' });
  });

  app.get('/api/tasks/:id/usage', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return { usage: await taskUsage(t.id) };
  });

  app.post('/api/tasks', (req, reply) => {
    const { project, priority = 0, status = 'backlog', labels = [] } = req.body || {};
    if (!project) return reply.code(400).send({ error: 'project required' });
    if (typeof project !== 'string') return reply.code(400).send({ error: 'project: the slug or the prefix of a project' });
    for (const f of ['title', 'description']) { const e = badText(req.body[f], f); if (e) return reply.code(400).send({ error: e }); }
    const title = String(req.body?.title ?? '');
    const description = String(req.body?.description ?? '');
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: 'bad status' });
    if (!['backlog', 'todo'].includes(status)) {
      return reply.code(400).send({ error: 'a task can only be created in Backlog or To do — everything else has to go through the working statuses' });
    }
    const p = resolveProject(project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) return reply.code(400).send({ error: 'priority: an integer 0-3' });
    const labelsArr = normalizeLabels(labels);
    if (labelsArr === null) return reply.code(400).send({ error: 'labels: an array of strings' });
    const badCreate = unknownLabels(labelsArr);
    if (badCreate.length) return reply.code(400).send(labelPaletteError(badCreate));
    if (labelsArr.includes(CHECK_LABEL) && OPEN_CHECK.includes(status)) {
      const open = openCheck(p.id);
      if (open) return reply.code(409).send({ error: `${open.key} is already checking this project`, reason: 'check-open', key: open.key });
    }
    const pos = nextPosition(p.id, status);
    const r = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, priority, status, labels, position) VALUES (?,?,?,?,?,?,?,?)')
      .run(p.id, nextTaskNo(p.id), title, description, priority, status, JSON.stringify(labelsArr), pos);
    const t = resolveTask(String(r.lastInsertRowid));
    enqueue('create_issue', t.id, snapshot(t));
    kick();
    emit('task.created', listShape({ ...t, comments_n: 0 }));
    return reply.code(201).send({ ...t, labels: JSON.parse(t.labels) });
  });

  app.post('/api/tasks/:id/duplicate', (req, reply) => {
    const src = taskOr404(req, reply); if (!src) return reply;
    const status = ['backlog', 'todo'].includes(src.status) ? src.status : 'todo';
    // that lands in Backlog is not an open check — it is let through
    if (isCheck(src) && OPEN_CHECK.includes(status)) {
      // "this check is still open" then, and how to start it again: ▶ on its card). With another open check too, ▶ on it is
      // refused (checkRefusal in routes/system.js), so the answer names that other one, and the page opens its card
      // check that goes first (leadCheck) — the very one, or the one whose ▶ starts; another open one would refuse too
      const open = leadCheck(src.project_id);
      if (open) return reply.code(409).send({ error: `${open.key} is already checking this project`, reason: 'check-open', key: open.key });
    }
    const pos = nextPosition(src.project_id, status);
    const r = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, priority, status, labels, position) VALUES (?,?,?,?,?,?,?,?)')
      .run(src.project_id, nextTaskNo(src.project_id), `${src.title} (copy)`, src.description, src.priority, status, src.labels, pos);
    const t = resolveTask(String(r.lastInsertRowid));
    enqueue('create_issue', t.id, snapshot(t));
    kick();
    emit('task.created', listShape({ ...t, comments_n: 0 }));
    return reply.code(201).send({ ...t, labels: JSON.parse(t.labels) });
  });

  app.post('/api/tasks/:id/move', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const { project } = req.body || {};
    if (typeof project !== 'string' || !project) return reply.code(400).send({ error: 'project: the slug or prefix of a project' });
    const p = resolveProject(project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (p.archived) return reply.code(400).send({ error: 'the project is archived' });
    if (p.id === t.project_id) return reply.code(400).send({ error: 'the task is already in this project' });
    if (['prep', 'doing', 'deploy'].includes(t.status) && !isManual(t.labels)) {
      return reply.code(409).send({ error: 'a task in work is not moved — Claude works on it under its key', reason: 'in-work' });
    }
    if (isCheck(t) && OPEN_CHECK.includes(t.status)) {
      const open = leadCheck(p.id);
      if (open) return reply.code(409).send({ error: `${open.key} is already checking that project`, reason: 'check-open', key: open.key });
    }
    const from = db.prepare('SELECT gh_project_number FROM projects WHERE id = ?').get(t.project_id);
    const fresh = db.transaction(() => {
      db.prepare('INSERT INTO task_moves (project_id, task_no, task_id) VALUES (?, ?, ?)').run(t.project_id, t.task_no, t.id);
      db.prepare("UPDATE tasks SET project_id = ?, task_no = ?, position = ?, gh_item_id = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(p.id, nextTaskNo(p.id), nextPosition(p.id, t.status), t.id);
      const f = resolveTask(String(t.id));
      // its issue leaves the board of the old project for the new one and is named anew: `[slug] title`, the key in the body
      if (t.gh_issue_number) {
        if (t.gh_item_id && from.gh_project_number) enqueue('remove_item', t.id, { project_number: from.gh_project_number, item_id: t.gh_item_id });
        enqueue('create_issue', t.id, snapshot(f));
        enqueue('update_issue', t.id, snapshot(f));
      }
      return f;
    })();
    kick();
    emit('task.moved', { id: fresh.id, key: fresh.key, old_key: t.key, project: fresh.project, prev_project: t.project });
    return { ...fresh, labels: JSON.parse(fresh.labels || '[]'), old_key: t.key };
  });

  app.patch('/api/tasks/:id', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const { description_base: base, ...b } = req.body || {};
    // Claude, another tab — the card's text would erase it silently: the description is left as it is, the rest of the
    // edit goes in, and the answer says so (`description_conflict`); the card asks the person which one to keep
    if (base !== undefined && typeof base !== 'string') return reply.code(400).send({ error: 'description_base: the description the edit started from' });
    const conflict = base !== undefined && b.description !== undefined && t.description !== base && t.description !== String(b.description ?? '');
    if (conflict) delete b.description;
    const flag = conflict ? { description_conflict: true } : {};
    const sid = requestSession(req);
    const plan = planPatch(t, b, sid);
    if (plan.error) { const { code, ...body } = plan; return reply.code(code).send(body); }
    const host = requestHostSession(req);
    if (!plan.updates.length) { bindSession(t.id, t.status, sid, host); return { ...t, labels: JSON.parse(t.labels || '[]'), ...flag }; }
    const fresh = db.transaction(() => commitPatch(t, b, plan, sid, host))();
    afterPatch(t, b, fresh, { sid });
    const warning = secondCheck(t, fresh);
    return { ...fresh, labels: JSON.parse(fresh.labels || '[]'), ...(warning ? { warning } : {}), ...flag };
  });

  app.post('/api/tasks/take', async (req, reply) => {
    const project = req.body?.project;
    if (typeof project !== 'string' || !project) return reply.code(400).send({ error: 'project: the slug or the prefix of a project' });
    const p = resolveProject(project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const sid = requestSession(req);
    const host = requestHostSession(req);
    const b = { status: 'prep' };
    const taken = db.transaction(() => {
      const t = db.prepare(`${TASK_SELECT} WHERE t.project_id = ? AND t.status = 'todo' AND t.blocked = 0 AND ${noclaudeFilter('t.')}
        ORDER BY t.pinned DESC, t.priority DESC, t.position, t.id LIMIT 1`).get(p.id);
      return t ? { t, fresh: commitPatch(t, b, planPatch(t, b, sid), sid, host) } : null;
    })();
    const blocked_n = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'todo' AND blocked = 1 AND ${noclaudeFilter()}`).get(p.id).n;
    // those left, a bare "empty" made Claude report an empty column while the human sees cards there
    const by_hand = db.prepare(`SELECT task_no FROM tasks WHERE project_id = ? AND status = 'todo' AND ${noclaudeFilter('', true)}
      ORDER BY pinned DESC, priority DESC, position, id`).all(p.id).map((r) => `${p.prefix}-${r.task_no}`);
    if (!taken) return { task: null, blocked_n, by_hand };
    afterPatch(taken.t, b, taken.fresh, { sid });
    return { task: await fullTask(taken.fresh), blocked_n, by_hand };
  });

  app.delete('/api/tasks/:id', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    db.prepare('DELETE FROM sync_queue WHERE task_id = ?').run(t.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    closeFinishedTerminals().catch(() => {});
    try { rmSync(join(ATTACH_DIR, String(t.id)), { recursive: true, force: true }); } catch {  }
    if (t.gh_issue_number) { enqueue('delete_issue', null, snapshot(t)); kick(); }
    emit('task.deleted', { id: t.id, key: t.key, project: t.project });
    return reply.code(204).send();
  });

  const withCommentImg = (c, taskId) => (c.image
    ? { ...c, image_url: `/attachments/${taskId}/${c.image}`, image_path: join(ATTACH_DIR, String(taskId), c.image) }
    : c);

  app.get('/api/tasks/:id/comments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id').all(t.id).map((c) => withCommentImg(c, t.id));
  });

  app.post('/api/tasks/:id/comments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (mime.startsWith('image/')) {
      const ext = MIME_EXT[mime];
      if (!ext) return reply.code(400).send({ error: 'images only: png, jpeg, webp, gif' });
      const buf = req.body;
      if (!buf || !buf.length) return reply.code(400).send({ error: 'empty body' });
      const imgs = db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND image IS NOT NULL AND image != ''").get(t.id).n;
      if (imgs >= ATTACH_MAX) return reply.code(400).send({ error: `limit of images in comments: ${ATTACH_MAX}` });
      const r = db.prepare("INSERT INTO task_comments (task_id, author, body, image) VALUES (?, 'me', '', '')").run(t.id);
      const file = `c${r.lastInsertRowid}.${ext}`;
      try {
        mkdirSync(join(ATTACH_DIR, String(t.id)), { recursive: true });
        writeFileSync(join(ATTACH_DIR, String(t.id), file), buf);
      } catch {
        db.prepare('DELETE FROM task_comments WHERE id = ?').run(r.lastInsertRowid);
        return reply.code(500).send({ error: 'could not save the file' });
      }
      db.prepare('UPDATE task_comments SET image = ? WHERE id = ?').run(file, r.lastInsertRowid);
      const c = withCommentImg(db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid), t.id);
      emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comment: c, comments_n: commentsN(t.id) });
      return reply.code(201).send(c);
    }
    const { body, author = 'me' } = req.body || {};
    const badBody = badText(body, 'body');
    if (badBody) return reply.code(400).send({ error: badBody });
    if (!body || !String(body).trim()) return reply.code(400).send({ error: 'body required' });
    const r = db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?,?,?)')
      .run(t.id, author === 'claude' ? 'claude' : 'me', String(body).trim());
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
    bindSession(t.id, t.status, requestSession(req), requestHostSession(req), { claim: false });
    enqueue('add_comment', t.id, { ...snapshot(t), comment_author: c.author, comment_body: c.body });
    kick();
    emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comment: c, comments_n: commentsN(t.id) });
    return reply.code(201).send(c);
  });

  app.delete('/api/tasks/:id/comments/:commentId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(req.params.commentId, t.id);
    if (!c) return reply.code(404).send({ error: 'comment not found' });
    if (c.image) { try { rmSync(join(ATTACH_DIR, String(t.id), c.image), { force: true }); } catch {  } }
    db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
    emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comments_n: commentsN(t.id) });
    return reply.code(204).send();
  });

  const taskOr404 = (req, reply, id = req.params.id, err = 'task not found') => {
    const found = resolveTask(id);
    if (!found) { reply.code(404).send({ error: err }); return null; }
    return found;
  };

  app.post('/api/tasks/:id/links', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const other = req.body?.key
      ? taskOr404(req, reply, req.body.key, 'the task to link to was not found')
      : (reply.code(404).send({ error: 'the task to link to was not found' }), null);
    if (!other) return reply;
    if (other.id === t.id) return reply.code(400).send({ error: 'a task cannot be linked to itself' });
    const rel = ['child', 'parent'].includes(req.body?.rel) ? req.body.rel : 'related';
    removeLinkPair(t.id, other.id);
    if (rel === 'child') db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'parent')").run(t.id, other.id);
    else if (rel === 'parent') db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'parent')").run(other.id, t.id);
    else { const [a, b] = [t.id, other.id].sort((x, y) => x - y); db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'related')").run(a, b); }
    placeAdjacent(t, other);
    emit('task.linked', { id: t.id, key: t.key, linked: { [t.id]: linkedIds(t.id), [other.id]: linkedIds(other.id) } });
    return taskLinks(t.id);
  });

  app.delete('/api/tasks/:id/links/:linkedId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const other = taskOr404(req, reply, req.params.linkedId, 'the task to link to was not found');
    if (!other) return reply;
    removeLinkPair(t.id, other.id);
    emit('task.linked', { id: t.id, key: t.key, linked: { [t.id]: linkedIds(t.id), [other.id]: linkedIds(other.id) } });
    return taskLinks(t.id);
  });

  app.post('/api/tasks/:id/attachments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = MIME_EXT[mime];
    if (!ext) return reply.code(400).send({ error: 'images only: png, jpeg, webp, gif' });
    const buf = req.body;
    if (!buf || !buf.length) return reply.code(400).send({ error: 'empty body' });
    const n = db.prepare("SELECT COUNT(*) AS n FROM task_attachments WHERE task_id = ? AND file != ''").get(t.id).n;
    if (n >= ATTACH_MAX) return reply.code(400).send({ error: `limit of attachments per task: ${ATTACH_MAX}` });
    const r = db.prepare('INSERT INTO task_attachments (task_id, file, mime) VALUES (?,?,?)').run(t.id, '', mime);
    const file = `${r.lastInsertRowid}.${ext}`;
    try {
      mkdirSync(join(ATTACH_DIR, String(t.id)), { recursive: true });
      writeFileSync(join(ATTACH_DIR, String(t.id), file), buf);
    } catch {
      db.prepare('DELETE FROM task_attachments WHERE id = ?').run(r.lastInsertRowid);
      return reply.code(500).send({ error: 'could not save the file' });
    }
    db.prepare('UPDATE task_attachments SET file = ? WHERE id = ?').run(file, r.lastInsertRowid);
    emit('task.attached', { task_id: t.id, key: t.key, attachments_n: attachmentsN(t.id) });
    return reply.code(201).send({ id: r.lastInsertRowid, file, mime, url: `/attachments/${t.id}/${file}`, path: join(ATTACH_DIR, String(t.id), file) });
  });

  app.get('/api/tasks/:id/attachments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return taskAttachments(t.id);
  });

  app.delete('/api/tasks/:id/attachments/:attachmentId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const a = db.prepare('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, t.id);
    if (!a) return reply.code(404).send({ error: 'attachment not found' });
    try { rmSync(join(ATTACH_DIR, String(t.id), a.file), { force: true }); } catch {  }
    db.prepare('DELETE FROM task_attachments WHERE id = ?').run(a.id);
    emit('task.attached', { task_id: t.id, key: t.key, attachments_n: attachmentsN(t.id) });
    return reply.code(204).send();
  });

  app.get('/api/tasks/:id/checklist', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return taskChecklist(t.id);
  });

  app.post('/api/tasks/:id/checklist', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const badItem = badText(req.body?.text, 'text');
    if (badItem) return reply.code(400).send({ error: badItem });
    const text = (req.body?.text ?? '').toString();
    const mx = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM task_checklist WHERE task_id = ?').get(t.id).m;
    const r = db.prepare('INSERT INTO task_checklist (task_id, text, position) VALUES (?,?,?)').run(t.id, text, mx + 1);
    checklistEvent(t);
    return reply.code(201).send({ id: r.lastInsertRowid, text, done: false, position: mx + 1 });
  });

  app.patch('/api/tasks/:id/checklist/:itemId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const item = db.prepare('SELECT * FROM task_checklist WHERE id = ? AND task_id = ?').get(req.params.itemId, t.id);
    if (!item) return reply.code(404).send({ error: 'checklist item not found' });
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.text !== undefined) {
      if (b.text === null || typeof b.text === 'object') return reply.code(400).send({ error: 'text: expected a string' });
      sets.push('text = ?'); vals.push(String(b.text));
    }
    if (b.done !== undefined) { sets.push('done = ?'); vals.push(b.done ? 1 : 0); }
    if (sets.length) { db.prepare(`UPDATE task_checklist SET ${sets.join(', ')} WHERE id = ?`).run(...vals, item.id); }
    bindSession(t.id, t.status, requestSession(req), requestHostSession(req), { claim: false });
    if (b.done !== undefined && !!b.done !== !!item.done) checklistEvent(t);
    else if (b.text !== undefined && String(b.text) !== item.text) checklistEvent(t, { textOnly: true });
    const fresh = db.prepare('SELECT id, text, done, position FROM task_checklist WHERE id = ?').get(item.id);
    return { ...fresh, done: !!fresh.done };
  });

  app.delete('/api/tasks/:id/checklist/:itemId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const item = db.prepare('SELECT * FROM task_checklist WHERE id = ? AND task_id = ?').get(req.params.itemId, t.id);
    if (!item) return reply.code(404).send({ error: 'checklist item not found' });
    db.prepare('DELETE FROM task_checklist WHERE id = ?').run(item.id);
    checklistEvent(t);
    return reply.code(204).send();
  });
}
