import { realpath, stat } from 'node:fs/promises';
import { db } from './db.js';
import { ensureWorktree, worktreeOf } from './worktrees.js';
import { profileById } from './profiles.js';
import { findTranscript } from './claude-sessions.js';
import { tailLines } from './own-wait.js';

export const ATTEMPTS_MAX = 5;

const rows = (taskId) => db.prepare('SELECT n, path, branch, profile_id, base FROM task_attempts WHERE task_id = ? ORDER BY n').all(taskId);

/** The attempts of a task: [{n, path, branch, base, profile, chosen}] — attempt 1 (its first copy) included once it has one. */
export function attemptsOf(task) {
  const own = worktreeOf(task.id);
  const list = rows(task.id);
  // the task's first copy, not written down as an attempt yet, is attempt 1
  if (own && !list.some((a) => a.path === own.path) && !list.some((a) => a.n === 1)) list.unshift({ n: 1, path: own.path, branch: own.branch, base: own.base, profile_id: null });
  return list.map((a) => ({ n: a.n, path: a.path, branch: a.branch, base: a.base || null, profile: a.profile_id ? (profileById(a.profile_id)?.name || null) : null, profile_id: a.profile_id || null, chosen: Boolean(own && own.path === a.path) }));
}

/* The tasks an attempt is being made for. The number of a new attempt is read before its copy is made, and making it takes
   git a while: a second press meanwhile read the same number and got git's own «cannot lock ref» back. */
const making = new Set();

/** A new attempt of the task: its copy made (nothing tied to the task yet) — {n, path, branch} or {error, reason}. */
export async function newAttempt(project, task, profileId = null) {
  if (!project.worktrees) return { error: 'attempts need the project\'s switch «Each task in its own copy of the repository»', reason: 'no-copies' };
  if (profileId !== null && !profileById(profileId)) return { error: 'profile: a launch profile there is', reason: 'profile' };
  if (making.has(task.id)) return { error: `an attempt at ${task.key} is being made right now — wait for it, then add another`, reason: 'busy' };
  making.add(task.id);
  try { return await makeAttempt(project, task, profileId); } finally { making.delete(task.id); }
}

async function makeAttempt(project, task, profileId) {
  const list = attemptsOf(task);
  if (list.length >= ATTEMPTS_MAX) return { error: `at most ${ATTEMPTS_MAX} attempts at a task`, reason: 'too-many' };
  // the first copy of the task is attempt 1: kept as one, so that taking another one does not lose it
  const own = worktreeOf(task.id);
  if (own && !rows(task.id).some((a) => a.n === 1) && own.branch === `claude/${task.key}`) {
    db.prepare('INSERT OR IGNORE INTO task_attempts (task_id, n, path, branch, base) VALUES (?, 1, ?, ?, ?)').run(task.id, own.path, own.branch, own.base);
  }
  const n = Math.max(1, ...attemptsOf(task).map((a) => a.n)) + 1;
  const made = await ensureWorktree(project, `${task.key}-a${n}`, []);
  if (made.error) return made;
  db.prepare('INSERT INTO task_attempts (task_id, n, path, branch, profile_id, base) VALUES (?, ?, ?, ?, ?, ?)').run(task.id, n, made.path, made.branch, profileId, made.base);
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
    db.prepare('INSERT INTO task_attempts (task_id, n, path, branch, base) VALUES (?, ?, ?, ?, ?)').run(task.id, own.branch === `claude/${task.key}` ? 1 : free, own.path, own.branch, own.base);
  }
  db.prepare(`INSERT INTO task_worktrees (task_id, path, branch, base) VALUES (?, ?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, base = excluded.base`).run(task.id, a.path, a.branch, a.base);
  return a;
}

/** The folder a session worked in, by its transcript; null when it does not say. Claude Code finds a conversation by the
    folder: a session of a worktree, an attempt or a subfolder cannot be brought back from the project's. */
export async function sessionFolder(sid, { fresh = false } = {}) {
  const path = await findTranscript(sid, { fresh });
  const size = path ? await stat(path).then((s) => s.size, () => 0) : 0;
  const lines = size ? await tailLines(path, size, 64 * 1024).catch(() => []) : [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const d = JSON.parse(lines[i]); if (typeof d?.cwd === 'string') return d.cwd; } catch { /* a cut line */ }
  }
  return null;
}
const real = async (p) => { try { return await realpath(p); } catch { return null; } };

/** `folder` when it is one a session of these tasks may go on in — the project's, a task's copy or one of its attempts
    (the board's own path of it) — else null. Nothing else: a folder read from a transcript is not trusted as it is. */
export async function knownFolder(folder, project, tasks) {
  const at = folder && await real(folder);
  if (!at) return null;
  const mine = [project?.path, ...tasks.map((t) => worktreeOf(t.id)?.path), ...tasks.flatMap((t) => rows(t.id).map((a) => a.path))];
  for (const f of mine) if (f && (await real(f)) === at) return f;
  return null;
}

export async function resumeFolder(sid, project, tasks, readFolder = (id) => sessionFolder(id, { fresh: true })) {
  // fresh: a person's press, once — a transcript the board missed a minute ago (MISS_TTL_MS) sent the task's first Claude
  const ran = await knownFolder(await readFolder(sid).catch(() => null), project, tasks);
  return ran || tasks.map((t) => worktreeOf(t.id)?.path).find(Boolean) || project.path;
}
