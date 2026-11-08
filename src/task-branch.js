import { execFile } from 'node:child_process';
import { db } from './db.js';
import { bin } from './bin-path.js';
import { ghAt } from './sync/github.js';
import { worktreeOf } from './worktrees.js';

export const PR_FRESH_MS = 60_000;
const CONFLICT_FRESH_MS = 30_000;
const git = (cwd, ...args) => new Promise((done) => {
  execFile(bin('git'), args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => done({ err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || '').trim(), text: `${errOut || out || ''}`.trim() }));
});

/** The base of the copy's branch: {ref (to compare with), name (for a pull request)} — or null. */
export async function baseOf(cwd) {
  const head = await git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  const tries = [head.err ? null : head.out, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'].filter(Boolean);
  for (const ref of tries) {
    if (!(await git(cwd, 'rev-parse', '--verify', '--quiet', ref)).err) return { ref, name: ref.replace(/^refs\/(remotes\/origin|heads)\//, '') };
  }
  return null;
}

const conflicts = new Map(); // task id → {at, head, base, value}
/** Whether the task's branch would merge into its base cleanly: {files: [...]} in conflict, [] — clean; null — cannot tell. */
export async function conflictOf(taskId, cwd, base) {
  const head = (await git(cwd, 'rev-parse', 'HEAD')).out;
  const baseSha = (await git(cwd, 'rev-parse', base.ref)).out;
  const kept = conflicts.get(taskId);
  if (kept && kept.head === head && kept.base === baseSha && Date.now() - kept.at < CONFLICT_FRESH_MS) return kept.value;
  const r = await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', base.ref, 'HEAD');
  let value = null;
  if (r.code === 0) value = { files: [] };
  else if (r.code === 1) value = { files: r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) };
  conflicts.set(taskId, { at: Date.now(), head, base: baseSha, value });
  return value;
}

/** What the card shows of the task's branch: null — the task has no copy; else {branch, base, ahead, conflict, pr}. */
export async function branchView(task) {
  const wt = worktreeOf(task.id);
  if (!wt) return null;
  const base = await baseOf(wt.path);
  const ahead = base ? Number((await git(wt.path, 'rev-list', '--count', `${base.ref}..HEAD`)).out) || 0 : null;
  const conflict = base && ahead ? await conflictOf(task.id, wt.path, base) : (base ? { files: [] } : null);
  return { branch: wt.branch, path: wt.path, base: base?.name || null, ahead, conflict, pr: await prOf(task, wt) };
}

const prRow = (taskId) => db.prepare('SELECT url, number, state, checked_at FROM task_prs WHERE task_id = ?').get(taskId) || null;
/** The pull request of the task as last known; asked of GitHub again when older than PR_FRESH_MS. */
export async function prOf(task, wt = worktreeOf(task.id)) {
  const row = prRow(task.id);
  if (!row || !wt) return row ? { url: row.url, number: row.number, state: row.state } : null;
  if (Date.now() - Date.parse(`${row.checked_at.replace(' ', 'T')}Z`) >= PR_FRESH_MS) {
    const r = await ghAt(wt.path, ['pr', 'view', row.url, '--json', 'number,url,state'], { timeout: 20_000 });
    if (!r.err) {
      try { const v = JSON.parse(r.out); keepPr(task.id, v); return { url: v.url, number: v.number, state: v.state }; } catch { /* the last known stays */ }
    }
  }
  return { url: row.url, number: row.number, state: row.state };
}
function keepPr(taskId, v) {
  db.prepare(`INSERT INTO task_prs (task_id, url, number, state, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (task_id) DO UPDATE SET url = excluded.url, number = excluded.number, state = excluded.state, checked_at = excluded.checked_at`)
    .run(taskId, v.url, v.number ?? null, String(v.state || 'OPEN').toUpperCase());
}

/** The body of the request: the card's description, the task's key and its issue. */
export function prBody(task, mirror = null) {
  const desc = String(task.description || '').trim();
  return [desc, `---\nTask ${task.key}${mirror && task.gh_issue_number ? ` · ${mirror}#${task.gh_issue_number}` : ''} (local-kanban)`].filter(Boolean).join('\n\n');
}

/** Push the branch of the task's copy and open a pull request for it (or find the one there is): {url, number, state}
    — or {error, reason}. */
export async function openPr(task, { mirror = null } = {}) {
  const wt = worktreeOf(task.id);
  if (!wt) return { error: 'the task has no copy of the repository of its own — a pull request is made from the branch of one', reason: 'no-branch' };
  const base = await baseOf(wt.path);
  if (!base) return { error: 'the repository of the task has no main branch to ask to merge into', reason: 'no-base' };
  const ahead = Number((await git(wt.path, 'rev-list', '--count', `${base.ref}..HEAD`)).out) || 0;
  if (!ahead) return { error: `the branch ${wt.branch} has no commits that ${base.name} has not — nothing to ask to merge`, reason: 'nothing' };
  const push = await git(wt.path, 'push', '-u', 'origin', `HEAD:refs/heads/${wt.branch}`);
  if (push.err) return { error: `git could not push ${wt.branch}: ${push.text.split('\n').filter(Boolean).pop() || 'no origin'}`, reason: 'push' };
  const title = `${task.key} ${String(task.title || '').trim() || task.key}`.slice(0, 250);
  const made = await ghAt(wt.path, ['pr', 'create', '--base', base.name, '--head', wt.branch, '--title', title, '--body', prBody(task, mirror)]);
  if (made.err && !/already exists/i.test(made.text)) return { error: `gh could not open the request: ${made.text.split('\n').filter(Boolean).pop() || made.err.message}`, reason: 'gh' };
  const view = await ghAt(wt.path, ['pr', 'view', wt.branch, '--json', 'number,url,state'], { timeout: 20_000 });
  let v = null;
  try { v = JSON.parse(view.out); } catch { /* below */ }
  if (!v?.url) {
    const url = made.out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop();
    if (!url) return { error: 'gh opened the request, but its address did not come back — look on GitHub', reason: 'gh' };
    v = { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null, state: 'OPEN' };
  }
  keepPr(task.id, v);
  return { url: v.url, number: v.number, state: String(v.state || 'OPEN').toUpperCase() };
}
