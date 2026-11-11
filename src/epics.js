import { db } from './db.js';

/** The longest plan the board keeps, in characters: a plan is a page of decisions and stages, not a dump. */
export const PLAN_MAX = 300_000;
/** How many versions of a plan the board keeps; older ones go. */
export const PLAN_KEEP = 50;

const versionsOf = (taskId) => db.prepare('SELECT version, length(body) AS size, created_at FROM task_plans WHERE task_id = ? ORDER BY version DESC').all(taskId);

/** What a card says of its plan: the current version, when it was written, how many versions — or null. */
export function planMeta(taskId) {
  const r = db.prepare('SELECT version, created_at, length(body) AS size, (SELECT COUNT(*) FROM task_plans p WHERE p.task_id = ?) AS versions_n FROM task_plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId, taskId);
  return r ? { version: r.version, at: r.created_at, size: r.size, versions_n: r.versions_n } : null;
}

/** A version of the plan (the current one without `version`) with the list of versions, or null. */
export function planOf(taskId, version = null) {
  const r = version == null
    ? db.prepare('SELECT version, body, created_at FROM task_plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId)
    : db.prepare('SELECT version, body, created_at FROM task_plans WHERE task_id = ? AND version = ?').get(taskId, version);
  if (!r) return null;
  const versions = versionsOf(taskId);
  return { version: r.version, at: r.created_at, body: r.body, current: versions[0]?.version ?? r.version, versions };
}

/** Why a plan's text cannot be kept, or null. */
export function planProblem(body) {
  if (typeof body !== 'string') return 'body: expected the text of the plan';
  if (!body.trim()) return 'body: the plan is empty';
  if (body.length > PLAN_MAX) return `body: the plan is longer than ${PLAN_MAX} characters`;
  return null;
}

/** Keeps a new version of the plan; the same text as the current one writes nothing. → the plan's meta with `changed`. */
export function savePlan(taskId, body, sessionId = null) {
  const text = body.replace(/\r\n?/g, '\n');
  return db.transaction(() => {
    const cur = db.prepare('SELECT version, body FROM task_plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId);
    if (cur && cur.body === text) return { ...planMeta(taskId), changed: false };
    const version = (cur?.version || 0) + 1;
    db.prepare('INSERT INTO task_plans (task_id, version, body, session_id) VALUES (?, ?, ?, ?)').run(taskId, version, text, sessionId);
    db.prepare('DELETE FROM task_plans WHERE task_id = ? AND version <= ?').run(taskId, version - PLAN_KEEP);
    return { ...planMeta(taskId), changed: true };
  })();
}

/** The file name a downloaded plan gets: the key of its card, so that two plans never share a name. */
export const planFileName = (key, version = null) => `${String(key).replace(/[^A-Za-z0-9-]/g, '')}-plan${version ? `-v${version}` : ''}.md`;

export const PORTION_MIN = 1;
export const PORTION_MAX = 10;
export const PORTION_DEFAULT = 3;
export const BATCH_TITLE_MAX = 200;
const CLOSED = new Set(['done', 'cancelled']);

/** A task's stage in a batch's progress: todo, working, ready, review, done, cancelled. */
export function batchStage(status) {
  if (status === 'backlog' || status === 'todo') return 'todo';
  if (status === 'prep' || status === 'doing' || status === 'deploy') return 'working';
  return status;
}
/** How many tasks of a batch stand at each stage. */
export function stageCounts(statuses) {
  const out = { todo: 0, working: 0, ready: 0, review: 0, done: 0, cancelled: 0, total: statuses.length };
  for (const s of statuses) { const k = batchStage(s); if (k in out) out[k]++; }
  return out;
}
/** A batch is through when every task of it is closed — the person accepted it (done) or dropped it (cancelled). */
export const batchClosed = (statuses) => statuses.length > 0 && statuses.every((s) => CLOSED.has(s));

/* The owner's word: the board leads the epic's status itself. Into Review when every task of its batches is closed and one
   at least was done — the person accepts the epic there; back to To do only from a Review the board itself put it in, when
   a task is opened again. A Review someone else gave it (Claude handed the epic in), a working status (a Claude works on
   the epic itself — its plan, its sub-tasks) and a closed epic are the person's and Claude's, and stay. The epic never goes
   into prep or doing by itself: those are a Claude's columns (a clock, a locked card, a queue held as «unfinished»). */
/** The status the board moves an epic to, or null. `subs` — the statuses of its batches' tasks. Pure. */
export function epicMove(status, subs, boardMoved) {
  if (!subs.length) return null;
  if (subs.every((s) => CLOSED.has(s)) && subs.includes('done')) return status === 'backlog' || status === 'todo' ? 'review' : null;
  if (status === 'review' && boardMoved) return 'todo';
  return null;
}

export const isEpic = (taskId) => Boolean(db.prepare('SELECT 1 FROM epic_batches WHERE epic_id = ? LIMIT 1').get(taskId));
export function throughEpicKey(taskIds) {
  if (!taskIds.length) return null;
  return db.prepare(`SELECT (p.prefix || '-' || e.task_no) AS key FROM batch_tasks bt JOIN epic_batches b ON b.id = bt.batch_id
    JOIN epics x ON x.task_id = b.epic_id AND x.through = 1 JOIN tasks e ON e.id = b.epic_id JOIN projects p ON p.id = e.project_id
    WHERE bt.task_id IN (SELECT value FROM json_each(?)) ORDER BY bt.task_id LIMIT 1`).get(JSON.stringify(taskIds))?.key ?? null;
}
/** The epic a task lies in a batch of, or null. */
export const epicOf = (taskId) => db.prepare('SELECT b.epic_id FROM batch_tasks bt JOIN epic_batches b ON b.id = bt.batch_id WHERE bt.task_id = ?').get(taskId)?.epic_id ?? null;

/** The epic's settings, its defaults where nothing was set. */
export function epicSettings(epicId) {
  const r = db.prepare('SELECT portion, auto_next, through, moved_event, run, launch FROM epics WHERE task_id = ?').get(epicId);
  let run = {};
  let launch = {};
  try { run = JSON.parse(r?.run || '{}') || {}; } catch { /* none */ }
  try { launch = JSON.parse(r?.launch || '{}') || {}; } catch { /* none */ }
  return { portion: r?.portion ?? PORTION_DEFAULT, auto_next: Boolean(r?.auto_next), through: Boolean(r?.through), moved_event: r?.moved_event ?? null, run, launch };
}
const ensureEpicRow = (epicId) => db.prepare('INSERT OR IGNORE INTO epics (task_id) VALUES (?)').run(epicId);

/** Why these settings cannot be kept, or null. */
export function settingsProblem(b) {
  if (b?.portion !== undefined && !(Number.isInteger(b.portion) && b.portion >= PORTION_MIN && b.portion <= PORTION_MAX)) return { error: `portion: a whole number from ${PORTION_MIN} to ${PORTION_MAX}`, field: 'portion' };
  if (b?.auto_next !== undefined && typeof b.auto_next !== 'boolean') return { error: 'auto_next: true or false', field: 'auto_next' };
  if (b?.through !== undefined && typeof b.through !== 'boolean') return { error: 'through: true or false', field: 'through' };
  return null;
}
export function saveSettings(epicId, b) {
  ensureEpicRow(epicId);
  if (b.portion !== undefined) db.prepare('UPDATE epics SET portion = ? WHERE task_id = ?').run(b.portion, epicId);
  if (b.auto_next !== undefined) db.prepare('UPDATE epics SET auto_next = ? WHERE task_id = ?').run(b.auto_next ? 1 : 0, epicId);
  if (b.through !== undefined) db.prepare('UPDATE epics SET through = ? WHERE task_id = ?').run(b.through ? 1 : 0, epicId);
}
export function saveRun(epicId, run) {
  ensureEpicRow(epicId);
  db.prepare('UPDATE epics SET run = ? WHERE task_id = ?').run(JSON.stringify(run || {}), epicId);
}
export function saveLaunch(epicId, launch) {
  ensureEpicRow(epicId);
  db.prepare('UPDATE epics SET launch = ? WHERE task_id = ?').run(JSON.stringify(launch || {}), epicId);
}
export function markMoved(epicId, eventId) {
  ensureEpicRow(epicId);
  db.prepare('UPDATE epics SET moved_event = ? WHERE task_id = ?').run(eventId, epicId);
}
/** The last move of the epic is the board's own. */
export function boardMovedLast(epicId) {
  const mine = epicSettings(epicId).moved_event;
  if (mine == null) return false;
  return db.prepare('SELECT id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(epicId)?.id === mine;
}

/** The epic's batches in order, each with its tasks in order, its number (from 1) and the counts of its stages. */
export function batchesOf(epicId) {
  const batches = db.prepare('SELECT id, title FROM epic_batches WHERE epic_id = ? ORDER BY position, id').all(epicId);
  const rows = db.prepare(`SELECT bt.batch_id, t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, t.title, t.status, t.blocked,
      t.priority, t.labels, EXISTS (SELECT 1 FROM epic_batches eb WHERE eb.epic_id = t.id) AS epic
    FROM batch_tasks bt JOIN epic_batches b ON b.id = bt.batch_id JOIN tasks t ON t.id = bt.task_id JOIN projects p ON p.id = t.project_id
    WHERE b.epic_id = ? ORDER BY bt.position, t.id`).all(epicId);
  const by = new Map(batches.map((b) => [b.id, []]));
  for (const r of rows) by.get(r.batch_id)?.push({ id: r.id, key: r.key, project: r.project, title: r.title, status: r.status, blocked: r.blocked, priority: r.priority, labels: JSON.parse(r.labels || '[]'), epic: Boolean(r.epic) });
  return batches.map((b, i) => {
    const tasks = by.get(b.id);
    const st = tasks.map((t) => t.status);
    return { id: b.id, n: i + 1, title: b.title, tasks, counts: stageCounts(st), closed: batchClosed(st) };
  });
}

/** The card's view of an epic: batches, the sub-tasks in none, the settings and the run. */
export function epicView(epicId) {
  const batches = batchesOf(epicId);
  const placed = new Set(batches.flatMap((b) => b.tasks.map((t) => t.id)));
  const loose = db.prepare(`SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, t.title, t.status, t.blocked, t.priority
    FROM task_links l JOIN tasks t ON t.id = l.linked_task_id JOIN projects p ON p.id = t.project_id
    WHERE l.kind = 'parent' AND l.task_id = ? ORDER BY t.id`).all(epicId).filter((t) => !placed.has(t.id));
  const s = epicSettings(epicId);
  return { batches, loose, portion: s.portion, auto_next: s.auto_next, through: s.through, run: s.run };
}

/** What the board's card of an epic shows: {batches_n, tasks_n, closed_n, current} — `current`, the number of the first
    batch not through (null — all are) — for the given task ids that are epics. One query. */
export function epicSummaries(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT b.epic_id, b.id AS batch_id, t.status FROM epic_batches b
      LEFT JOIN batch_tasks bt ON bt.batch_id = b.id LEFT JOIN tasks t ON t.id = bt.task_id
    WHERE b.epic_id IN (SELECT value FROM json_each(?)) ORDER BY b.epic_id, b.position, b.id, bt.position`).all(JSON.stringify(ids));
  const per = new Map();
  for (const r of rows) {
    const e = per.get(r.epic_id) || new Map();
    per.set(r.epic_id, e);
    const list = e.get(r.batch_id) || [];
    e.set(r.batch_id, list);
    if (r.status) list.push(r.status);
  }
  for (const [epicId, batches] of per) {
    const lists = [...batches.values()];
    const all = lists.flat();
    const open = lists.findIndex((st) => !batchClosed(st) && st.length);
    out.set(epicId, { batches_n: lists.length, tasks_n: all.length, closed_n: all.filter((s) => CLOSED.has(s)).length, current: open < 0 ? null : open + 1 });
  }
  return out;
}
export const epicSummary = (id) => epicSummaries([id]).get(id) || null;

const batchOfEpic = (epicId, batchId) => db.prepare('SELECT id, title FROM epic_batches WHERE id = ? AND epic_id = ?').get(batchId, epicId);
export const titleProblem = (title) => (title !== undefined && title !== null && typeof title !== 'string' ? 'title: expected a string'
  : String(title ?? '').length > BATCH_TITLE_MAX ? `title: at most ${BATCH_TITLE_MAX} characters` : null);

/** A new batch at the end of the epic's → its id. */
export function addBatch(epicId, title = '') {
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM epic_batches WHERE epic_id = ?').get(epicId).p;
  ensureEpicRow(epicId);
  return Number(db.prepare('INSERT INTO epic_batches (epic_id, title, position) VALUES (?, ?, ?)').run(epicId, String(title ?? '').trim(), pos).lastInsertRowid);
}
/** The epic's batch with this title, made at the end when there is none; a number — the batch at that place, the next
    number makes a new one (`kb add --batch 1` on a fresh epic), a number past it — null. */
export function batchByName(epicId, name) {
  const word = String(name ?? '').trim();
  if (/^\d+$/.test(word)) {
    const all = batchesOf(epicId);
    const n = Number(word);
    if (all[n - 1]) return all[n - 1].id;
    return n === all.length + 1 ? addBatch(epicId, '') : null;
  }
  const same = db.prepare('SELECT id FROM epic_batches WHERE epic_id = ? AND title = ? COLLATE NOCASE ORDER BY position LIMIT 1').get(epicId, word);
  return same ? same.id : addBatch(epicId, word);
}
export function renameBatch(epicId, batchId, title) {
  return db.prepare('UPDATE epic_batches SET title = ? WHERE id = ? AND epic_id = ?').run(String(title ?? '').trim(), batchId, epicId).changes > 0;
}
/** The batch goes; its tasks stay sub-tasks of the epic, in no batch. */
export function deleteBatch(epicId, batchId) {
  return db.prepare('DELETE FROM epic_batches WHERE id = ? AND epic_id = ?').run(batchId, epicId).changes > 0;
}
/** The batches in this order: `ids` — every batch of the epic, each once. → an error or null. */
export function orderBatches(epicId, ids) {
  const have = db.prepare('SELECT id FROM epic_batches WHERE epic_id = ?').all(epicId).map((r) => r.id);
  if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((id) => have.includes(id))) {
    return 'batches: every batch of the epic, each once';
  }
  db.transaction(() => ids.forEach((id, i) => db.prepare('UPDATE epic_batches SET position = ? WHERE id = ?').run(i + 1, id)))();
  return null;
}

/** Puts `task` into the epic's batch `batchId` before the task `beforeId` (none — at the end), or into no batch (`batchId`
    null — it stays a sub-task). The task becomes a sub-task of the epic if it was not; a place in another epic's batch, and
    its link to that epic, go. → {error, code} or null. */
/** Why `task` cannot lie in a batch of `epic`, or null — asked before anything is made (a batch by its title). */
export function placeProblem(epic, task) {
  if (task.id === epic.id) return { code: 400, error: 'a task is not a batch of itself', field: 'key' };
  if (epicOf(epic.id) === task.id) return { code: 400, error: `${epic.key} lies in a batch of ${task.key} — it cannot hold it in its own`, field: 'key' };
  return null;
}
export function placeTask(epic, task, batchId, beforeId = null) {
  const problem = placeProblem(epic, task);
  if (problem) return problem;
  if (batchId != null && !batchOfEpic(epic.id, batchId)) return { code: 404, error: 'no such batch in this epic', field: 'batch' };
  db.transaction(() => {
    const was = epicOf(task.id);
    if (was && was !== epic.id) db.prepare('DELETE FROM task_links WHERE (task_id = ? AND linked_task_id = ?) OR (task_id = ? AND linked_task_id = ?)').run(was, task.id, task.id, was);
    const link = db.prepare("SELECT 1 FROM task_links WHERE kind = 'parent' AND task_id = ? AND linked_task_id = ?").get(epic.id, task.id);
    if (!link) {
      db.prepare('DELETE FROM task_links WHERE (task_id = ? AND linked_task_id = ?) OR (task_id = ? AND linked_task_id = ?)').run(epic.id, task.id, task.id, epic.id);
      db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'parent')").run(epic.id, task.id);
    }
    if (batchId == null) { db.prepare('DELETE FROM batch_tasks WHERE task_id = ?').run(task.id); return; }
    const before = beforeId == null ? null : db.prepare('SELECT position FROM batch_tasks WHERE task_id = ? AND batch_id = ?').get(beforeId, batchId);
    let pos;
    if (before) {
      const prev = db.prepare('SELECT MAX(position) AS p FROM batch_tasks WHERE batch_id = ? AND position < ? AND task_id != ?').get(batchId, before.position, task.id).p;
      pos = prev == null ? before.position - 1 : (prev + before.position) / 2;
    } else {
      pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM batch_tasks WHERE batch_id = ? AND task_id != ?').get(batchId, task.id).p;
    }
    db.prepare('INSERT INTO batch_tasks (task_id, batch_id, position) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET batch_id = excluded.batch_id, position = excluded.position').run(task.id, batchId, pos);
  })();
  return null;
}
