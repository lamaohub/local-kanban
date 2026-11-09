import { execFile } from 'node:child_process';
import { db } from './db.js';
import { bin } from './bin-path.js';
import { ghAt } from './sync/github.js';
import { worktreeOf } from './worktrees.js';
import { emit } from './bus.js';
import { taskEvent } from './task-shape.js';

export const PR_FRESH_MS = 60_000;
const CONFLICT_FRESH_MS = 30_000;
const git = (cwd, ...args) => new Promise((done) => {
  execFile(bin('git'), args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => done({ err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || '').trim(), raw: String(out || ''), text: `${errOut || out || ''}`.trim() }));
});

/** The line of a failed git or gh to say: its `fatal:`/`error:` line (git ends with advice — «and the repository exists.»),
    else its last; nothing printed — how it failed, never its command line (it holds the card's whole description). */
export function failLine(r, what) {
  if (r.err?.killed || (r.err?.signal && !r.text)) return `${what} did not answer in time`;
  const lines = String(r.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /^(fatal|error):/i.test(l)) || lines.at(-1);
  if (said) return said.slice(0, 300);
  if (r.err?.code === 'ENOENT') return `${what} is not on this computer`;
  return `${what} failed${typeof r.err?.code === 'number' ? ` with code ${r.err.code}` : ''}`;
}

/** The base of the copy's branch: {ref (to compare with), name (for a pull request)} — or null. `prefer` — the branch the
    copy was made from (worktreeOf(…).base), tried first. */
export async function baseOf(cwd, prefer = null) {
  const own = prefer ? [`refs/remotes/origin/${prefer}`, `refs/heads/${prefer}`] : [];
  const head = await git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  const tries = [...own, head.err ? null : head.out, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'].filter(Boolean);
  for (const ref of tries) {
    if (!(await git(cwd, 'rev-parse', '--verify', '--quiet', ref)).err) return { ref, name: ref.replace(/^refs\/(remotes\/origin|heads)\//, '') };
  }
  return null;
}

/** The files in conflict of `git merge-tree --write-tree --name-only -z` (code 1): the tree, then a name an element up to
    the empty one (the messages after it are not asked for). Pure. */
export function conflictFiles(raw) {
  const parts = String(raw || '').split('\0').slice(1);
  const end = parts.indexOf('');
  return [...new Set(end < 0 ? parts : parts.slice(0, end))];
}

const conflicts = new Map(); // task id → {at, head, base, value}
/** Whether the task's branch would merge into its base cleanly: {files: [...]} in conflict, [] — clean; null — cannot tell. */
export async function conflictOf(taskId, cwd, base) {
  const head = (await git(cwd, 'rev-parse', 'HEAD')).out;
  const baseSha = (await git(cwd, 'rev-parse', base.ref)).out;
  const kept = conflicts.get(taskId);
  if (kept && kept.head === head && kept.base === baseSha && Date.now() - kept.at < CONFLICT_FRESH_MS) return kept.value;
  const r = await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base.ref, 'HEAD');
  let value = null;
  if (r.code === 0) value = { files: [] };
  else if (r.code === 1) value = { files: conflictFiles(r.raw) };
  conflicts.set(taskId, { at: Date.now(), head, base: baseSha, value });
  return value;
}

const count = async (cwd, range) => { const r = await git(cwd, 'rev-list', '--count', range); return r.err ? null : Number(r.out) || 0; };

/** What the card shows of the task's branch: null — the task has no copy; else {branch, base, ahead, conflict, pr,
    ahead_of_pr} — `ahead_of_pr` the commits of the branch past the head of its request (null — not known). */
export async function branchView(task) {
  const wt = worktreeOf(task.id);
  if (!wt) return null;
  const base = await baseOf(wt.path, wt.base);
  const ahead = base ? (await count(wt.path, `${base.ref}..HEAD`)) || 0 : null;
  const conflict = base && ahead ? await conflictOf(task.id, wt.path, base) : (base ? { files: [] } : null);
  const pr = await prOf(task, wt);
  const head = pr && prRow(task.id)?.head;
  return { branch: wt.branch, path: wt.path, base: base?.name || null, ahead, conflict, pr, ahead_of_pr: head ? await count(wt.path, `${head}..HEAD`) : null };
}

const prRow = (taskId) => db.prepare('SELECT url, number, state, checked_at, head FROM task_prs WHERE task_id = ?').get(taskId) || null;
const shownPr = (row) => ({ url: row.url, number: row.number, state: row.state });
const asking = new Map(); // task id → the ask of GitHub in flight: one at a time, every look waits for the same
/** The pull request of the task as last known; asked of GitHub again when the last ask is older than PR_FRESH_MS. */
export async function prOf(task, wt = worktreeOf(task.id)) {
  const row = prRow(task.id);
  if (!row || !wt) return row ? shownPr(row) : null;
  if (Date.now() - Date.parse(`${row.checked_at.replace(' ', 'T')}Z`) < PR_FRESH_MS) return shownPr(row);
  if (!asking.has(task.id)) {
    asking.set(task.id, (async () => {
      const r = await ghAt(wt.path, ['pr', 'view', row.url, '--json', 'number,url,state,headRefOid'], { timeout: 20_000 });
      let v = null;
      if (!r.err) { try { v = JSON.parse(r.out); } catch { /* the last known stays */ } }
      if (!v?.url) { // the ask is written down all the same: the next look does not wait for gh again
        db.prepare("UPDATE task_prs SET checked_at = datetime('now') WHERE task_id = ?").run(task.id);
        return shownPr(row);
      }
      keepPr(task.id, v);
      return shownPr(prRow(task.id));
    })().finally(() => asking.delete(task.id)));
  }
  return asking.get(task.id);
}
function keepPr(taskId, v) {
  const was = prRow(taskId);
  const state = String(v.state || 'OPEN').toUpperCase();
  db.prepare(`INSERT INTO task_prs (task_id, url, number, state, head, checked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (task_id) DO UPDATE SET url = excluded.url, number = excluded.number, state = excluded.state,
      head = COALESCE(excluded.head, task_prs.head), checked_at = excluded.checked_at`)
    .run(taskId, v.url, v.number ?? null, state, v.headRefOid || null);
  if (!was || was.url !== v.url || was.number !== (v.number ?? null) || was.state !== state) emit('task.updated', taskEvent(taskId));
}

/** The body of the request: the card's description, the task's key and its issue. */
export function prBody(task, mirror = null) {
  const desc = String(task.description || '').trim();
  return [desc, `---\nTask ${task.key}${mirror && task.gh_issue_number ? ` · ${mirror}#${task.gh_issue_number}` : ''} (local-kanban)`].filter(Boolean).join('\n\n');
}

/** Push the branch of the task's copy and open a pull request for it (or find the one open there is): {url, number, state}
    — or {error, reason}. A request merged or closed is not taken for the new one: its address is gh's answer. */
export async function openPr(task, { mirror = null } = {}) {
  const wt = worktreeOf(task.id);
  if (!wt) return { error: 'the task has no copy of the repository of its own — a pull request is made from the branch of one', reason: 'no-branch' };
  const base = await baseOf(wt.path, wt.base);
  if (!base) return { error: 'the repository of the task has no main branch to ask to merge into', reason: 'no-base' };
  const ahead = Number((await git(wt.path, 'rev-list', '--count', `${base.ref}..HEAD`)).out) || 0;
  if (!ahead) return { error: `the branch ${wt.branch} has no commits that ${base.name} has not — nothing to ask to merge`, reason: 'nothing' };
  const push = await git(wt.path, 'push', '-u', 'origin', `HEAD:refs/heads/${wt.branch}`);
  if (push.err) return { error: `git could not push ${wt.branch}: ${failLine(push, 'git')}`, reason: 'push' };
  const title = `${task.key} ${String(task.title || '').trim() || task.key}`.slice(0, 250);
  const made = await ghAt(wt.path, ['pr', 'create', '--base', base.name, '--head', wt.branch, '--title', title, '--body', prBody(task, mirror)]);
  const exists = made.err && /already exists/i.test(made.text);
  if (made.err && !exists) return { error: `gh could not open the request: ${failLine(made, 'gh')}`, reason: 'gh' };
  // the address gh printed — of the new request, or of the open one «already exists» names; by the branch only when it
  // printed none, and then only an open one: a merged or closed request of the branch is not the new one
  const said = `${made.out}\n${made.text}`.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\/\S+\/pull\/\d+$/.test(l)).pop() || null;
  const view = await ghAt(wt.path, ['pr', 'view', said || wt.branch, '--json', 'number,url,state,headRefOid'], { timeout: 20_000 });
  let v = null;
  try { v = JSON.parse(view.out); } catch { /* below */ }
  if (v?.url && !said && String(v.state).toUpperCase() !== 'OPEN') v = null;
  if (!v?.url) {
    if (!said) return { error: 'gh opened the request, but its address did not come back — look on GitHub', reason: 'gh' };
    v = { url: said, number: Number(/\/pull\/(\d+)/.exec(said)?.[1]) || null, state: 'OPEN' };
  }
  if (!v.headRefOid) v.headRefOid = (await git(wt.path, 'rev-parse', 'HEAD')).out || null;
  keepPr(task.id, v);
  return { url: v.url, number: v.number, state: String(v.state || 'OPEN').toUpperCase() };
}
