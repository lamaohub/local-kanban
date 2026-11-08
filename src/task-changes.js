import { execFile } from 'node:child_process';
import { db } from './db.js';
import { bin } from './bin-path.js';
import { worktreeOf } from './worktrees.js';
import { baseOf } from './task-branch.js';
import { LOG_FORMAT, parseLog } from './shipped.js';

export const LOG_SCAN = 300;
export const COMMITS_MAX = 30;
export const FILES_MAX = 200;
export const LINES_MAX = 6000;
const git = (cwd, args) => new Promise((done) => {
  execFile(bin('git'), ['-c', 'core.quotePath=false', ...args], { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out) => done(err ? null : String(out)));
});

/** A unified diff (`git show`/`git diff`, no colour) as [{path, old, add, del, binary, hunks: [{head, lines: [{t: '+'|'-'|' ', text,
    old, new}]}]}] — `old`/`new` the line's number on each side (null on the side it is not on). Pure. */
export function parseDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      f = { path: m ? m[1] : line.slice(11), old: null, add: 0, del: 0, binary: false, hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('rename from ')) { f.old = line.slice(12); continue; }
    if (line.startsWith('Binary files ')) { f.binary = true; continue; }
    if (!h && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') || /^(new|deleted) file mode|^similarity index|^rename to|^old mode|^new mode/.test(line))) continue;
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (at) {
      o = Number(at[1]); n = Number(at[2]);
      h = { head: line, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const t = line[0];
    if (t === '+') { h.lines.push({ t, text: line.slice(1), old: null, new: n++ }); f.add++; } else if (t === '-') { h.lines.push({ t, text: line.slice(1), old: o++, new: null }); f.del++; } else if (t === ' ') { h.lines.push({ t, text: line.slice(1), old: o++, new: n++ }); } // «\ No newline» and the rest — not a line of the file
  }
  return files;
}

/** Keep at most FILES_MAX files and LINES_MAX lines of `parts` ([{files}]), in order: whether anything was cut. */
function trim(parts) {
  let lines = 0;
  let files = 0;
  let cut = false;
  for (const p of parts) {
    const kept = [];
    for (const f of p.files) {
      if (files >= FILES_MAX || lines >= LINES_MAX) { cut = true; break; }
      files++;
      for (const h of f.hunks) {
        if (lines + h.lines.length > LINES_MAX) { h.lines = h.lines.slice(0, Math.max(0, LINES_MAX - lines)); f.cut = true; cut = true; }
        lines += h.lines.length;
      }
      kept.push(f);
    }
    p.files = kept;
  }
  return cut;
}

/** What changed for the task: {source: 'copy'|'folder'|null, branch?, base?, commits: [{hash, subject, files}], uncommitted:
    {files, shared}|null, cut}. `words` — the words its commits are known by (routes/tasks.js `taskWords`). */
export async function taskChanges(task, { words = [task.key], known = null, copy = null } = {}) {
  const wt = copy || worktreeOf(task.id);
  const folder = wt?.path || db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path;
  if (!folder || (await git(folder, ['rev-parse', '--git-dir'])) === null) return { source: null, commits: [], uncommitted: null, cut: false };
  let hashes = [];
  let base = null;
  if (wt) {
    base = await baseOf(folder);
    const out = base ? await git(folder, ['rev-list', '--no-merges', `--max-count=${COMMITS_MAX}`, `${base.ref}..HEAD`]) : null;
    hashes = String(out || '').split('\n').filter(Boolean);
  } else {
    const log = await git(folder, ['log', '-n', String(LOG_SCAN), '--no-merges', `--format=${LOG_FORMAT}`]);
    hashes = parseLog(log, known).filter((c) => words.some((w) => c.words.has(w))).slice(0, COMMITS_MAX).map((c) => c.hash);
  }
  const commits = [];
  for (const hash of hashes) {
    const out = await git(folder, ['show', '--no-color', '--find-renames', '-U3', '--format=%H%n%s', hash, '--', '.']);
    if (out === null) continue;
    const [full, subject, ...rest] = out.split('\n');
    commits.push({ hash: full, subject, files: parseDiff(rest.join('\n')) });
  }
  const diff = await git(folder, ['diff', 'HEAD', '--no-color', '--find-renames', '-U3', '--', '.']);
  const files = parseDiff(diff);
  const uncommitted = files.length ? { files, shared: !wt } : null;
  const cut = trim([...commits, ...(uncommitted ? [uncommitted] : [])]);
  return { source: wt ? 'copy' : 'folder', folder, ...(wt ? { branch: wt.branch, base: base?.name || null } : {}), commits, uncommitted, cut };
}
