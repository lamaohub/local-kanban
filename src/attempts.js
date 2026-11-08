import { db } from './db.js';
import { ensureWorktree, worktreeOf } from './worktrees.js';
import { profileById } from './profiles.js';

export const ATTEMPTS_MAX = 5;

const rows = (taskId) => db.prepare('SELECT n, path, branch, profile_id FROM task_attempts WHERE task_id = ? ORDER BY n').all(taskId);

/** The attempts of a task: [{n, path, branch, profile, chosen}] — attempt 1 (its first copy) included once it has one. */
export function attemptsOf(task) {
  const own = worktreeOf(task.id);
  const list = rows(task.id);
  // the task's first copy, not written down as an attempt yet, is attempt 1
  if (own && !list.some((a) => a.path === own.path) && !list.some((a) => a.n === 1)) list.unshift({ n: 1, path: own.path, branch: own.branch, profile_id: null });
  return list.map((a) => ({ n: a.n, path: a.path, branch: a.branch, profile: a.profile_id ? (profileById(a.profile_id)?.name || null) : null, profile_id: a.profile_id || null, chosen: Boolean(own && own.path === a.path) }));
}

/** A new attempt of the task: its copy made (nothing tied to the task yet) — {n, path, branch} or {error, reason}. */
export async function newAttempt(project, task, profileId = null) {
  if (!project.worktrees) return { error: 'attempts need the project\'s switch «Each task in its own copy of the repository»', reason: 'no-copies' };
  if (profileId !== null && !profileById(profileId)) return { error: 'profile: a launch profile there is', reason: 'profile' };
  const list = attemptsOf(task);
  if (list.length >= ATTEMPTS_MAX) return { error: `at most ${ATTEMPTS_MAX} attempts at a task`, reason: 'too-many' };
  // the first copy of the task is attempt 1: kept as one, so that taking another one does not lose it
  const own = worktreeOf(task.id);
  if (own && !rows(task.id).some((a) => a.n === 1) && own.branch === `claude/${task.key}`) {
    db.prepare('INSERT OR IGNORE INTO task_attempts (task_id, n, path, branch) VALUES (?, 1, ?, ?)').run(task.id, own.path, own.branch);
  }
  const n = Math.max(1, ...attemptsOf(task).map((a) => a.n)) + 1;
  const made = await ensureWorktree(project, `${task.key}-a${n}`, []);
  if (made.error) return made;
  db.prepare('INSERT INTO task_attempts (task_id, n, path, branch, profile_id) VALUES (?, ?, ?, ?, ?)').run(task.id, n, made.path, made.branch, profileId);
  return { n, path: made.path, branch: made.branch };
}

/** The attempt `n` of a task: {n, path, branch, profile_id} or null. */
export const attemptOf = (task, n) => attemptsOf(task).find((a) => a.n === n) || null;

/** «Take this one»: the attempt's copy becomes the task's own. */
export function takeAttempt(task, n) {
  const a = attemptOf(task, n);
  if (!a) return null;
  const own = worktreeOf(task.id);
  if (own && !rows(task.id).some((x) => x.path === own.path)) { // the copy the task had is kept as an attempt
    const free = Math.max(0, ...attemptsOf(task).map((x) => x.n)) + 1;
    db.prepare('INSERT INTO task_attempts (task_id, n, path, branch) VALUES (?, ?, ?, ?)').run(task.id, own.branch === `claude/${task.key}` ? 1 : free, own.path, own.branch);
  }
  db.prepare(`INSERT INTO task_worktrees (task_id, path, branch) VALUES (?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET path = excluded.path, branch = excluded.branch`).run(task.id, a.path, a.branch);
  return a;
}
