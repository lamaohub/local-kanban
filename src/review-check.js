
import { db } from './db.js';

export const CHECK_LABEL = 'check';
/** The statuses of a check that is still open: made and not started yet, or worked on. The section of the page
    holds the same list (public/js/review-rules.js); a test keeps the two equal. A check in Review is the report
    of an earlier check, for the person to read. */
export const OPEN_CHECK = ['todo', 'prep', 'doing', 'deploy'];

function labelsOf(t) {
  if (Array.isArray(t?.labels)) return t.labels;
  try { const l = JSON.parse(t?.labels || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
export const isCheck = (t) => labelsOf(t).includes(CHECK_LABEL);

/** The open check of a project — `{key}` of the newest one — or null. `except` — a task not to count (the one asked about). */
export function openCheck(projectId, except = 0) {
  const rows = db.prepare(`SELECT t.task_no, t.labels, p.prefix FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.id != ? AND t.status IN (${OPEN_CHECK.map(() => '?').join(', ')}) AND t.labels LIKE '%"check"%'
    ORDER BY t.id DESC`).all(projectId, except, ...OPEN_CHECK);
  const r = rows.find(isCheck);
  return r ? { key: `${r.prefix}-${r.task_no}` } : null;
}

/** The open check of the project that goes first — one already started (out of To do), else the oldest — `{id, key}`
    or null. */
export function leadCheck(projectId) {
  const rows = db.prepare(`SELECT t.id, t.task_no, t.labels, p.prefix FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN (${OPEN_CHECK.map(() => '?').join(', ')}) AND t.labels LIKE '%"check"%'
    ORDER BY t.status = 'todo', t.id`).all(projectId, ...OPEN_CHECK);
  const r = rows.find(isCheck);
  return r ? { id: r.id, key: `${r.prefix}-${r.task_no}` } : null;
}

/** A change made `after` an open check while it was not one `before` (the label put on, a report sent back to To do),
    and the project has another open check: `{reason: 'check-open', key, text}` — or null. */
export function secondCheck(before, after) {
  const open = (t) => isCheck(t) && OPEN_CHECK.includes(t.status);
  if (open(before) || !open(after)) return null;
  const lead = leadCheck(after.project_id);
  const other = lead && lead.id !== after.id ? lead : openCheck(after.project_id, after.id);
  return other ? { reason: 'check-open', key: other.key, text: `this project already has an open check: ${other.key}` } : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkedKeys(check) {
  const p = db.prepare('SELECT id, prefix FROM projects WHERE id = ?').get(check.project_id);
  if (!p) return [];
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(p.prefix)}-(\\d+)(?![0-9])`, 'gi');
  const nos = [...new Set([...String(check.description || '').matchAll(re)].map((m) => Number(m[1])))];
  const one = db.prepare('SELECT task_no, status, labels FROM tasks WHERE project_id = ? AND task_no = ?');
  return nos
    .map((no) => one.get(p.id, no))
    .filter((t) => t && t.status === 'review' && !isCheck(t) && t.task_no !== check.task_no)
    .map((t) => `${p.prefix}-${t.task_no}`);
}

/** What Claude started on these tasks may run on top of the board's own commands: `kb done` for every task a
    check among them takes, the key exactly as the board writes it — one rule per task, nothing wider. */
export function doneRules(tasks) {
  const keys = (tasks || []).filter(isCheck).flatMap(checkedKeys);
  return [...new Set(keys)].map((k) => `Bash(kb done ${k})`);
}
