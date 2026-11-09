import { execFile, spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db.js';
import { bin } from './bin-path.js';
import { worktreeOf } from './worktrees.js';
import { baseOf } from './task-branch.js';
import { LOG_FORMAT, parseLog } from './shipped.js';

export const LOG_SCAN = 300;
export const COMMITS_MAX = 30;
export const FILES_MAX = 200;
export const LINES_MAX = 6000;
export const TEXT_MAX = 1_500_000;
export const LINE_CHARS_MAX = 2000;
export const FILE_LINES_MAX = 3000;
export const UNTRACKED_BYTES_MAX = 1024 * 1024;
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
// the board's own reading of a diff, whatever the owner's git config says of prefixes, colours and external tools
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--find-renames', '-U3'];
const git = (cwd, args) => new Promise((done) => {
  execFile(bin('git'), ['-c', 'core.quotePath=false', ...args], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: ENV },
    (err, out) => done(err ? null : String(out)));
});

/** A C-quoted name of git (`"dir/a\"b\303\251"`) as it is; a name not quoted — as it came. Pure. */
export function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  const ESC = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    bytes.push(ESC[n] ?? n.charCodeAt(0)); i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}
const side = (s) => unquote(s.replace(/\t$/, '')).replace(/^[ab]\//, ''); // git ends a name holding a space with a tab
/** The path of `diff --git a/X b/X` — taken only when both sides are the same name (a name holding « b/» is otherwise
    ambiguous: the `+++`/`---` lines and `rename to` say it for sure). */
function headerPath(rest) {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return end > 0 ? side(rest.slice(end + 2)) : side(rest);
  }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    if (rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  }
  const m = / b\/(.*)$/.exec(rest);
  return m ? (m[1].endsWith('"') ? unquote(`"${m[1]}`) : m[1]) : rest;
}

/** Reads a unified diff a line at a time into [{path, old, add, del, binary, big?, cut?, hunks: [{head, lines: [{t: '+'|'-'|' ',
    text, old, new, cut?}]}]}] — `old`/`new` the line's number on each side (null on the side it is not on) — while the
    shared `budget` {files, lines, text} lasts; `line()` answers false when it is spent (`budget.cut` is then true). */
export class DiffReader {
  constructor(budget = { files: Infinity, lines: Infinity, text: Infinity }) {
    this.budget = budget; this.files = []; this.f = null; this.h = null; this.o = 0; this.n = 0; this.minus = null; this.stopped = false;
  }
  line(line, long = false) {
    const b = this.budget;
    if (line.startsWith('diff --git ')) {
      if (b.files <= 0) { b.cut = true; this.stopped = true; return false; }
      b.files -= 1;
      this.f = { path: headerPath(line.slice(11)), old: null, add: 0, del: 0, binary: false, hunks: [] };
      this.files.push(this.f);
      this.h = null; this.minus = null;
      return true;
    }
    const f = this.f;
    if (!f) return true;
    if (!this.h) {
      if (line.startsWith('rename from ')) { f.old = unquote(line.slice(12)); return true; }
      if (line.startsWith('rename to ')) { f.path = unquote(line.slice(10)); return true; }
      if (line.startsWith('Binary files ')) { f.binary = true; return true; }
      if (line.startsWith('--- ')) { this.minus = line.slice(4) === '/dev/null' ? null : side(line.slice(4)); return true; }
      if (line.startsWith('+++ ')) { const p = line.slice(4); f.path = p === '/dev/null' ? (this.minus ?? f.path) : side(p); return true; }
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      this.o = Number(at[1]); this.n = Number(at[2]);
      this.h = f.big ? SKIP : { head: line.slice(0, LINE_CHARS_MAX), lines: [] };
      if (!f.big) f.hunks.push(this.h);
      return true;
    }
    const h = this.h;
    if (!h) return true;
    const t = line[0];
    if (t !== '+' && t !== '-' && t !== ' ') return true; // «\ No newline» and the rest — not a line of the file
    if (t === '+') f.add++; else if (t === '-') f.del++;
    if (h === SKIP) return true; // a file past FILE_LINES_MAX: counted, not kept
    if (f.add + f.del > FILE_LINES_MAX) { // too large to show line by line: named, its lines let go back to the budget
      for (const x of f.hunks) { b.lines += x.lines.length; b.text += x.lines.reduce((n, l) => n + l.text.length, 0); }
      f.big = true; f.hunks = []; delete f.cut; this.h = SKIP;
      return true;
    }
    if (b.lines <= 0 || b.text <= 0) { f.cut = true; b.cut = true; this.stopped = true; return false; }
    let text = line.slice(1);
    const cut = long || text.length > LINE_CHARS_MAX;
    if (text.length > LINE_CHARS_MAX) text = text.slice(0, LINE_CHARS_MAX);
    b.lines -= 1; b.text -= text.length;
    const l = t === '+' ? { t, text, old: null, new: this.n++ } : t === '-' ? { t, text, old: this.o++, new: null } : { t, text, old: this.o++, new: this.n++ };
    if (cut) l.cut = true;
    h.lines.push(l);
    return true;
  }
}
const SKIP = { lines: [] };

/** A unified diff (`git show`/`git diff`, no colour) read whole — see DiffReader. Pure. */
export function parseDiff(text) {
  const r = new DiffReader();
  for (const line of String(text || '').split('\n')) r.line(line);
  return r.files;
}

/** Run git and hand its output to `reader` a line at a time — never more than LINE_CHARS_MAX characters of a line held,
    git stopped once the reader has had enough. {code, stopped}. */
function streamGit(cwd, args, reader) {
  return new Promise((done) => {
    const child = spawn(bin('git'), ['-c', 'core.quotePath=false', ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    const cap = LINE_CHARS_MAX * 4 + 4; // bytes: the characters of a line kept, in UTF-8 at worst
    let parts = [];
    let held = 0;
    let long = false;
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill('SIGKILL'); }, 30_000);
    const emitLine = () => {
      const text = Buffer.concat(parts, held).toString('utf8');
      const wasLong = long;
      parts = []; held = 0; long = false;
      if (!reader.line(text, wasLong)) { stopped = true; child.stdout.destroy(); child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (chunk) => {
      let at = 0;
      while (!stopped && at < chunk.length) {
        const nl = chunk.indexOf(10, at);
        const end = nl < 0 ? chunk.length : nl;
        const room = cap - held;
        if (end - at > room) long = true; // the rest of the line is read past, not kept
        if (room > 0 && end > at) { const piece = chunk.subarray(at, Math.min(end, at + room)); parts.push(piece); held += piece.length; }
        if (nl < 0) break;
        emitLine();
        at = nl + 1;
      }
    });
    child.on('error', () => { clearTimeout(timer); done({ code: -1, stopped }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stopped && held) emitLine();
      done({ code: code ?? -1, stopped });
    });
  });
}

/** `--numstat -z` of git: [{path, old, add, del}] (add/del null for a binary file). Pure. */
export function parseNumstat(out) {
  const parts = String(out || '').split('\0');
  const list = [];
  for (let i = 0; i < parts.length; i += 1) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i].replace(/^\n+/, ''));
    if (!m) continue;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') { list.push({ old: parts[i + 1], path: parts[i + 2], add, del }); i += 2; } else list.push({ path: m[3], old: null, add, del });
  }
  return list;
}

/** One diff of `args` (`show <hash>` or `diff HEAD`): the files past FILE_LINES_MAX named by git's numstat and left out of
    the patch, the rest read as a stream under the budget. {files, cut, failed}. */
async function readDiff(cwd, args, budget) {
  const fmt = args[0] === 'show' ? ['--format='] : [];
  const stat = parseNumstat(await git(cwd, [...args, '--numstat', '-z', '--relative', '--find-renames', ...fmt, '--', '.']));
  const big = stat.filter((s) => (s.add ?? 0) + (s.del ?? 0) > FILE_LINES_MAX).slice(0, FILES_MAX);
  const leave = big.flatMap((s) => [s.path, s.old].filter(Boolean)).map((p) => `:(exclude,literal)${p}`);
  const reader = new DiffReader(budget);
  const r = await streamGit(cwd, [...args, ...DIFF, '--relative', ...fmt, '--', '.', ...leave], reader);
  const files = reader.files;
  for (const s of big) {
    if (budget.files <= 0) { budget.cut = true; break; }
    budget.files -= 1;
    files.push({ path: s.path, old: s.old, add: s.add, del: s.del, binary: false, big: true, hunks: [] });
  }
  // in git's order (by path), the large ones among the rest
  const order = new Map(stat.map((s, i) => [s.path, i]));
  files.sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9));
  return { files, cut: reader.stopped, failed: r.code !== 0 && !r.stopped };
}

/** The files git does not know yet (not ignored), read as new files under the same budget: [{…, untracked: true}]. */
async function readUntracked(cwd, budget) {
  const names = String(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']) || '').split('\0')
    .filter((n) => n && !n.endsWith('/')); // a folder — a repository of its own inside
  const files = [];
  for (const name of names) {
    if (budget.files <= 0 || budget.lines <= 0 || budget.text <= 0) { budget.cut = true; break; }
    const st = await lstat(join(cwd, name)).catch(() => null);
    if (!st) continue;
    if (st.size > UNTRACKED_BYTES_MAX) {
      budget.files -= 1;
      files.push({ path: name, old: null, add: null, del: 0, binary: false, big: true, untracked: true, hunks: [] });
      continue;
    }
    const reader = new DiffReader(budget);
    // code 1 — the files differ, which a new file always does; the index is not touched
    await streamGit(cwd, ['diff', '--no-index', ...DIFF, '--', '/dev/null', name], reader);
    for (const f of reader.files) { f.path = name; f.untracked = true; files.push(f); }
    if (reader.stopped) break;
  }
  return files;
}

/** What changed for the task: {source: 'copy'|'folder'|null, branch?, base?, commits: [{hash, subject, files, cut?}],
    uncommitted: {files, shared}|null, cut}. `words` — the words its commits are known by (routes/tasks.js `taskWords`). */
export async function taskChanges(task, { words = [task.key], known = null, copy = null } = {}) {
  const wt = copy || worktreeOf(task.id);
  const folder = wt?.path || db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path;
  if (!folder || (await git(folder, ['rev-parse', '--git-dir'])) === null) return { source: null, commits: [], uncommitted: null, cut: false };
  let list = [];
  let base = null;
  if (wt) {
    base = await baseOf(folder, wt.base);
    const out = base ? await git(folder, ['log', '--no-merges', `--max-count=${COMMITS_MAX + 1}`, '--format=%H%x1f%s', `${base.ref}..HEAD`]) : null;
    list = String(out || '').split('\n').filter(Boolean).map((l) => { const [hash, subject = ''] = l.split('\x1f'); return { hash, subject }; });
  } else {
    const log = await git(folder, ['log', '-n', String(LOG_SCAN), '--no-merges', `--format=${LOG_FORMAT}`]);
    list = parseLog(log, known).filter((c) => words.some((w) => c.words.has(w))).slice(0, COMMITS_MAX + 1).map((c) => ({ hash: c.hash, subject: c.subject }));
  }
  const budget = { files: FILES_MAX, lines: LINES_MAX, text: TEXT_MAX, cut: list.length > COMMITS_MAX };
  const spent = () => budget.files <= 0 || budget.lines <= 0 || budget.text <= 0;
  const commits = [];
  for (const c of list.slice(0, COMMITS_MAX)) {
    if (spent()) { budget.cut = true; commits.push({ ...c, files: [], cut: true }); continue; } // listed, not read
    const r = await readDiff(folder, ['show', c.hash], budget);
    commits.push({ ...c, files: r.files, ...(r.cut || r.failed ? { cut: true } : {}) });
  }
  let files = [];
  if (!spent()) files = (await readDiff(folder, ['diff', 'HEAD'], budget)).files;
  if (!spent()) files.push(...await readUntracked(folder, budget));
  else budget.cut = true;
  const uncommitted = files.length ? { files, shared: !wt } : null;
  return { source: wt ? 'copy' : 'folder', folder, ...(wt ? { branch: wt.branch, base: base?.name || null } : {}), commits, uncommitted, cut: Boolean(budget.cut) };
}
