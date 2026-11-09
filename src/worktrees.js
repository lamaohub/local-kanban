import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { db } from './db.js';
import { bin } from './bin-path.js';

export const WORKTREES_DIR = join('.claude', 'worktrees');
const KEY_RE = /^[A-Z0-9]{1,10}-\d+(-a\d{1,2})?$/;

const git = (cwd, args) => new Promise((done) => {
  execFile(bin('git'), ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => done({ err, out: String(out || '').trim(), text: `${out || ''}${errOut || ''}`.trim() }));
});

/** The lines of the project's field: [{how: 'copy'|'link', path}] — relative paths inside the project, nothing else. */
export function filesOf(field) {
  const out = [];
  for (const raw of String(field || '').split('\n')) {
    const m = /^\s*(copy|link)\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const path = m[2];
    if (path.startsWith('/') || path.split(/[\\/]/).includes('..')) continue; // inside the project only
    out.push({ how: m[1], path });
  }
  return out;
}
/** The problem of the field, or null: every non-empty line is «copy <path>» or «link <path>» inside the project. */
export function filesProblem(field) {
  for (const raw of String(field || '').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^\s*(copy|link)\s+(.+?)\s*$/.exec(raw);
    if (!m) return `worktree_files: a line is «copy <path>» or «link <path>»: ${raw.trim().slice(0, 60)}`;
    if (m[2].startsWith('/') || m[2].split(/[\\/]/).includes('..')) return `worktree_files: a path inside the project, not ${m[2].slice(0, 60)}`;
  }
  return null;
}

export function worktreeOf(taskId) {
  const row = db.prepare('SELECT path, branch, base FROM task_worktrees WHERE task_id = ?').get(taskId);
  return row && existsSync(row.path) ? row : null;
}

function excludeLine(from, commonDir, line, why) {
  // git prints --git-common-dir relative to the folder it was asked in (review: from a subfolder it is «../../.git»)
  const file = join(resolve(from, commonDir), 'info', 'exclude');
  try {
    const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (now.split('\n').some((l) => l.trim() === line)) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${now && !now.endsWith('\n') ? '\n' : ''}# local-kanban: ${why}\n${line}\n`);
  } catch { /* the path shows in git status then — nothing breaks */ }
}
const excludeCopies = (from, commonDir) => excludeLine(from, commonDir, `/${WORKTREES_DIR.split(sep).join('/')}/`, 'the copies of tasks (CK-993)');

/** Where the copy of `key` is for the project — read only, nothing made: {path (the folder Claude starts in), branch, top,
    repo, from, commonDir} — or {error, reason}. */
export async function planWorktree(project, key) {
  if (!KEY_RE.test(key)) return { error: `not a task key: ${key}`, reason: 'worktree' };
  let from;
  try { from = realpathSync(project.path); } catch { return { error: 'the folder of the project is not on this computer', reason: 'worktree' }; }
  const at = await git(from, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (at.err) return { error: 'the folder of the project is not a git repository — the copies of tasks need one', reason: 'worktree-no-git' };
  const [repo, commonDir] = at.out.split('\n');
  // a project that is one folder of a bigger repository: both sides real paths (review: a link in the project's path made «../..»)
  const rel = relative(realpathSync(repo), from);
  const top = join(repo, WORKTREES_DIR, key);
  return { path: rel ? join(top, rel) : top, branch: `claude/${key}`, top, repo, from, commonDir };
}

/** The base a copy at `path` is known by — of a task or of an attempt; null when none is written down. */
export const knownBase = (path) => db.prepare(`SELECT base FROM task_worktrees WHERE path = ? AND base IS NOT NULL
  UNION ALL SELECT base FROM task_attempts WHERE path = ? AND base IS NOT NULL LIMIT 1`).get(path, path)?.base || null;

export async function ensureWorktree(project, key, tasks = []) {
  const plan = await planWorktree(project, key);
  if (plan.error) return plan;
  const { repo, top, branch, commonDir } = plan;
  const listed = async () => (await git(repo, ['worktree', 'list', '--porcelain'])).out.split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice(9)));
  let known = await listed();
  // a copy whose folder was removed by hand stays listed («prunable») — prune it, then make it again (review)
  if (known.includes(resolve(top)) && !existsSync(top)) { await git(repo, ['worktree', 'prune']); known = await listed(); }
  let created = false;
  let base = knownBase(plan.path);
  if (!known.includes(resolve(top))) {
    if (existsSync(top)) return { error: `${top} is there and is not a copy of this repository — move it away`, reason: 'worktree' };
    const has = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    // a new branch starts at the checkout's HEAD: the branch it is on is the base (none — a detached HEAD)
    if (has.err) { const on = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']); base = on.err ? null : on.out || null; }
    const add = await git(repo, has.err ? ['worktree', 'add', '-b', branch, top] : ['worktree', 'add', top, branch]);
    if (add.err) return { error: `git could not make the copy: ${add.text.split('\n').pop()}`, reason: 'worktree' };
    created = true;
    excludeCopies(plan.from, commonDir);
  }
  const folder = plan.path;
  // the files outside git — on every start: what is missing comes, what is there is left as it is
  for (const f of filesOf(project.worktree_files)) {
    const src = join(project.path, f.path);
    const to = join(folder, f.path);
    if (!existsSync(src)) continue;
    if (f.how === 'link' && !(await git(plan.from, ['check-ignore', '-q', '--', f.path])).err) {
      excludeLine(plan.from, commonDir, `/${relative(realpathSync(repo), join(plan.from, f.path)).split(sep).join('/')}`, 'a link of the copies of tasks (CK-993)');
    }
    try { lstatSync(to); continue; } catch { /* not there — made below */ }
    try {
      mkdirSync(dirname(to), { recursive: true });
      if (f.how === 'link') symlinkSync(src, to);
      else await cp(src, to, { recursive: true, verbatimSymlinks: true }); // not on the main thread's time: data/ may be large
    } catch { /* one file that did not come is not the start's fault: Claude sees it missing */ }
  }
  const tie = db.prepare(`INSERT INTO task_worktrees (task_id, path, branch, base) VALUES (?, ?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, base = excluded.base`);
  for (const t of tasks) tie.run(t.id, folder, branch, base);
  return { path: folder, branch, top, created, base };
}

/** The folder a start of these tasks of `project` runs in: the project's, or — when the project gives each task its own
    copy — the copy the first task already has, else a new one of it, which the tasks without a copy of their own join.
    `dry` — where it would be, nothing made (a dry run starts nothing). */
export async function taskFolder(project, tasks, { dry = false } = {}) {
  if (!project.worktrees || !tasks.length) return { path: project.path };
  const own = tasks.map((t) => ({ t, w: worktreeOf(t.id) })).find((x) => x.w);
  const key = own ? own.w.branch.replace(/^claude\//, '') : tasks[0].key;
  if (dry) return own ? { ...own.w, dry: true } : { ...(await planWorktree(project, key)), dry: true };
  return ensureWorktree(project, key, tasks.filter((t) => !worktreeOf(t.id) || t.id === own?.t.id));
}
