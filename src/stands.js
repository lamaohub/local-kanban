
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, open, readdir, readlink, realpath, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { db } from './db.js';
import { readRegistry, stateOf } from './claude-live.js';
import { bin } from './bin-path.js';
import { alternate } from './shipped.js';

const GIT_MS = 20_000;
const DU_MS = 120_000;
const AT_ONCE = 4; // folders walked side by side
export const STANDS_FRESH_MS = 10 * 60_000; // an older picture is walked again on the next look
export const FORCE_EVERY_MS = 15_000; // «Check again» — not more often
const WORK = new Set(['prep', 'doing', 'ready', 'deploy']);
const KEPT_BRANCHES = new Set(['main', 'master']); // never a stand's branch to delete
const DIFF_MAX = 200_000;

/* Ignored files a removal may take without a word: what a build or an install makes again, and the settings Claude Code
   writes for a session of the folder. The rest of the ignored files — a `.env`, `data/`, `var/` — is kept unless the main
   checkout holds the very same bytes at the same place. Measured on 05.11.2026 on the owner's tree of 176 stands: 58 held
   such data (villa_tap/var, server_panel/data, inst.bot/app/data, a .env, older copies of skills). */
const REGEN_DIRS = new Set(['node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'coverage', 'dist', 'build', '.gradle']);
const REGEN_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json']);
const SESSION_FILES = new Set(['.claude/settings.local.json', '.claude/launch.json']);
/** An ignored path (relative to the stand, «dir/» for a folder) that a removal may take: made again by a build or an
    install, or the settings of a Claude session of the folder. Pure. */
export function regenerable(rel) {
  const clean = String(rel).replace(/\/+$/, '');
  if (SESSION_FILES.has(clean)) return true;
  const parts = clean.split('/');
  if (parts.some((x) => REGEN_DIRS.has(x))) return true;
  const name = parts[parts.length - 1];
  return REGEN_FILES.has(name) || /\.(pyc|tsbuildinfo)$/.test(name);
}
const KEPT_MAX = 20; // the paths of ignored data a stand lists
const LOOK_MAX = 20_000; // the entries looked at in one stand — past them its ignored files are «not known»

const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
function run(cmd, args, { cwd, timeout = GIT_MS, max = 32 * 1024 * 1024, extra = null } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: max, env: extra ? { ...env, ...extra } : env }, (err, out) => resolve(err ? { err, out: String(out || '') } : { out: String(out) }));
  });
}
const git = (dir, args, opts) => run(bin('git'), ['-C', dir, ...args], opts);
const real = async (p) => { try { return await realpath(p); } catch { return p; } };
export const within = (folder, path) => {
  const rel = relative(folder, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** `git worktree list --porcelain` read: [{path, head, branch, detached, locked, prunable, bare}] — the first is the main
    checkout. Pure. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const w = {};
    for (const line of block.split('\n')) {
      const [k, ...rest] = line.split(' ');
      const v = rest.join(' ');
      if (k === 'worktree') w.path = v;
      else if (k === 'HEAD') w.head = v;
      else if (k === 'branch') w.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') w.detached = true;
      else if (k === 'locked') w.locked = v || true;
      else if (k === 'prunable') w.prunable = v || true;
      else if (k === 'bare') w.bare = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

/** The key of a task in the name of a folder or a branch («ck-559-kanban-task-0e9ea3», «claude/IB-830») — upper case —
    whose prefix is one of `prefixes`; null. A hash tail («pdf-ee85f1») is no key. Pure. */
export function keyIn(names, prefixes) {
  for (const name of names) {
    for (const m of String(name || '').matchAll(/(?:^|[^a-z0-9])([a-z][a-z0-9]{0,9})-(\d{1,6})(?=$|[^a-z0-9])/gi)) {
      const prefix = m[1].toUpperCase();
      if (prefixes.has(prefix)) return `${prefix}-${Number(m[2])}`;
    }
  }
  return null;
}

/* The issues a message names: «(lamaohub/server-comp#6144)», «#6144». A bare number of a few digits is no proof of the same
   work — only `owner/repo#N` counts, the form the board's commits carry. */
const ISSUE = /\b[\w.-]+\/[\w.-]+#(\d+)\b/g;
export const issuesIn = (msg) => [...String(msg || '').matchAll(ISSUE)].map((m) => m[1]);

/** A title that names its work: three words and fifteen characters at least — the board's commits are sentences; «WIP»,
    «Fix tests», «Update README» stand in any long log for other work. */
export const telling = (title) => String(title || '').trim().length >= 15 && String(title).trim().split(/\s+/).length >= 3;
export function matchCommits(cherry, messages, main, inMain = new Set()) {
  const out = [];
  for (const line of String(cherry).split('\n')) {
    const m = /^([+-]) ([0-9a-f]{7,64})/.exec(line.trim());
    if (!m) continue;
    const msg = messages.get(m[2]) || { title: '', body: '' };
    let found = null;
    let like = null;
    if (m[1] === '-') found = 'patch';
    else {
      if (inMain.has(m[2])) found = 'content';
      const issues = issuesIn(`${msg.title}\n${msg.body}`);
      if (telling(msg.title) && main.titles.has(msg.title)) like = 'title';
      else if (issues.length && issues.every((n) => main.issues.has(n))) like = 'issue';
    }
    out.push({ sha: m[2], title: msg.title, found, like: found ? null : like });
  }
  return out;
}

/** `git status --porcelain -z --ignored` read: {changed: ['XY path'…], ignored: [path…]}. `-z` — the names come as they
    are: without it a name in Cyrillic comes quoted and escaped, and no file of that name is found. Pure. */
export function parseStatusZ(out) {
  const items = String(out).split('\0');
  const changed = [];
  const ignored = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.length < 4) continue;
    if (it.startsWith('!! ')) { ignored.push(it.slice(3)); continue; }
    changed.push(it);
    if (it[0] === 'R' || it[0] === 'C') i += 1; // a rename or a copy: its old name follows
  }
  return { changed, ignored };
}

/** The ignored files of a stand that the main checkout `top` does not hold with the same bytes: {files, paths} (the first
    KEPT_MAX); null when they could not all be looked at. `ignored` — the «!!» paths of `git status --ignored`. */
async function keptIgnored(dir, top, ignored) {
  const out = [];
  let looked = 0;
  // piece by piece: a database of a stand is hundreds of megabytes, and four stands are walked at once
  const same = async (a, b) => {
    let x; let y;
    try {
      [x, y] = await Promise.all([open(a), open(b)]);
      const bx = Buffer.alloc(1 << 20); const by = Buffer.alloc(1 << 20);
      for (;;) {
        const [rx, ry] = await Promise.all([x.read(bx, 0, bx.length, null), y.read(by, 0, by.length, null)]);
        if (rx.bytesRead !== ry.bytesRead || !bx.subarray(0, rx.bytesRead).equals(by.subarray(0, ry.bytesRead))) return false;
        if (rx.bytesRead === 0) return true;
      }
    } catch { return false; } finally { await x?.close().catch(() => {}); await y?.close().catch(() => {}); }
  };
  const visit = async (rel) => {
    if (regenerable(rel)) return true;
    if ((looked += 1) > LOOK_MAX) return false;
    const a = join(dir, rel);
    const b = join(top, rel);
    let st;
    try { st = await lstat(a); } catch { out.push(rel); return true; } // not to be read: kept, not taken for nothing
    if (st.isSymbolicLink()) {
      let same2 = false;
      try { same2 = (await readlink(a)) === (await readlink(b)); } catch { /* not in main */ }
      if (!same2) out.push(rel);
      return true;
    }
    if (st.isDirectory()) {
      let names;
      try { names = await readdir(a); } catch { return false; }
      for (const n of names) if (!(await visit(`${rel.replace(/\/+$/, '')}/${n}`))) return false;
      return true;
    }
    let other = null;
    try { other = await lstat(b); } catch { /* not in main */ }
    if (!other?.isFile() || other.size !== st.size || !(await same(a, b))) out.push(rel);
    return true;
  };
  for (const rel of ignored) if (!(await visit(rel))) return null;
  return { files: out.length, paths: out.slice(0, KEPT_MAX) };
}

/** The commits of `shas` whose changes main already holds: each put onto `ref` by itself (`git merge-tree` against its
    first parent) leaves the tree of `ref` as it is. A commit that changes nothing (an empty one) proves nothing — it would
    merge to main's tree anyway; a root commit, a merge that does not go clean, or a git that cannot say — not in main.
    `merge-tree --write-tree` writes the trees it makes: into an object folder of its own that reads the repository's as
    an alternate, so a look leaves nothing in the owner's repository. `repo` — {tree, objects} of `ref`, asked once per
    repository (repoOf). Two calls of git for the lot, then one merge-tree a commit. */
async function inMainByContent(top, ref, shas, repo) {
  const out = new Set();
  if (!shas.length || !repo?.tree || !repo.objects) return out;
  const list = shas.slice(0, 200);
  const lg = await git(top, ['log', '--no-walk=unsorted', '--format=%H %T %P', ...list]);
  if (lg.err) return out;
  const of = new Map();
  for (const line of lg.out.split('\n')) {
    const [sha, tree, parent] = line.trim().split(' ');
    if (sha && tree && parent) of.set(sha, { tree, parent });
  }
  const parents = [...new Set([...of.values()].map((c) => c.parent))];
  const pt = parents.length ? await git(top, ['rev-parse', ...parents.map((p) => `${p}^{tree}`)]) : { out: '' };
  if (pt.err) return out;
  const parentTree = new Map(parents.map((p, i) => [p, pt.out.split('\n')[i]?.trim()]));
  const scratch = await mkdtemp(join(tmpdir(), 'kb-stand-'));
  const extra = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(repo.objects) };
  try {
    for (const sha of list) {
      const c = of.get(sha);
      if (!c || c.tree === parentTree.get(c.parent)) continue; // no parent, or nothing changed: no proof
      const m = await git(top, ['merge-tree', '--write-tree', `--merge-base=${c.parent}`, ref, sha], { extra });
      if (!m.err && m.out.split('\n')[0].trim() === repo.tree) out.add(sha);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}
/** The merges of `head` not in `ref` that carry changes of their own: [{sha, title}], null when git cannot say. `git cherry`
    passes merges over, so a fix made while merging, or a conflict resolved by hand, read as nothing to lose. A merge of
    two parents is merged again (`git merge-tree --write-tree`, into an object folder of its own as inMainByContent): a
    tree of its own, a conflict, more than two parents, or no folder of objects to merge in — changes of its own. A clean
    merge (main caught up into the branch) is no work. */
export const MERGES_MAX = 200; // the merges of one branch merged again; past it the branch is not looked at whole
async function ownMerges(top, ref, head, repo) {
  const lg = await git(top, ['log', '--merges', `--max-count=${MERGES_MAX + 1}`, '--format=%H%x1f%T%x1f%P%x1f%s', `${ref}..${head}`]);
  if (lg.err) return null;
  const lines = lg.out.split('\n').filter(Boolean);
  if (lines.length > MERGES_MAX) return null; // the merges past the bound were never merged again: no proof, not «nothing»
  const merges = lines.map((line) => {
    const [sha, tree, parents, title = ''] = line.split('\x1f');
    return { sha, tree, parents: parents.trim().split(' '), title: title.trim() };
  });
  if (!merges.length) return [];
  const out = [];
  const scratch = repo?.objects ? await mkdtemp(join(tmpdir(), 'kb-stand-')) : null;
  const extra = scratch ? { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(repo.objects) } : null;
  try {
    for (const m of merges) {
      let clean = false;
      if (extra && m.parents.length === 2) {
        const r = await git(top, ['merge-tree', '--write-tree', m.parents[0], m.parents[1]], { extra });
        clean = !r.err && r.out.split('\n')[0].trim() === m.tree;
      }
      if (!clean) out.push({ sha: m.sha, title: m.title });
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

/** The tree of `ref` and the object folder of the repository of `top`: {tree, objects}, nulls when git cannot say. */
async function repoGit(top, ref) {
  const [t, o] = await Promise.all([git(top, ['rev-parse', `${ref}^{tree}`]), git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])]);
  return { tree: t.err ? null : t.out.trim(), objects: o.err ? null : o.out.trim() };
}

/** The state of a stand from what was read of it. Pure: {state: 'reading'|'busy'|'unsent'|'free', why: [words…]}. */
export function standState(s) {
  if (s.read === false) return { state: 'reading', why: [] }; // the walk has not come to it yet
  const why = [];
  if (s.keeps) why.push('main');
  if (s.home) why.push('project'); // a project of the board lives in the folder
  if (s.sessions) why.push('session');
  if (s.processes) why.push('process');
  if (s.task && WORK.has(s.task.status)) why.push('task');
  if (why.length) return { state: 'busy', why };
  if (s.locked) why.push('locked');
  if (s.dirty === null || s.commits === null || s.processes === null || s.ignored === null) why.push('unknown'); // git or lsof did not answer, no main to measure by, too many ignored files to look at
  if (s.dirty) why.push('dirty');
  if (s.ignored?.files) why.push('ignored');
  if (s.commits?.some((c) => !c.found && !c.merge)) why.push('commits');
  if (s.commits?.some((c) => !c.found && c.merge)) why.push('merge'); // git cherry passes merges over
  if (s.detached && s.commits?.length) why.push('detached');
  if (why.length) return { state: 'unsent', why };
  return { state: 'free', why: [] };
}

/** The main branch of the origin to measure against: origin/main, origin/master, else the local main/master — the full
    ref, {ref, name}; null. Every git call names the full ref: a local branch named «origin/main» wins over the remote one
    when the short name is given (refs/heads comes before refs/remotes), and the stands were measured against it. */
async function mainRef(top) {
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    const r = await git(top, ['rev-parse', '--verify', '--quiet', ref]);
    if (!r.err && r.out.trim()) return { ref, name: ref.replace(/^refs\/(remotes|heads)\//, '') };
  }
  return null;
}

/** The titles and issue numbers in the log of main (the newest 50 000 commits). */
async function mainLog(top, ref) {
  const r = await git(top, ['log', '--max-count=50000', '--format=%s%x1f%b%x1e', ref], { max: 256 * 1024 * 1024, timeout: 60_000 });
  const titles = new Set();
  const issues = new Set();
  if (r.err) return { titles, issues, failed: true };
  for (const rec of r.out.split('\x1e')) {
    const [title, body = ''] = rec.split('\x1f');
    const t = title.trim();
    if (t) titles.add(t);
    for (const n of issuesIn(`${t}\n${body}`)) issues.add(n);
  }
  return { titles, issues };
}

/** The folders where some process stands (its cwd) — one call to lsof; null when lsof did not answer. */
async function processFolders() {
  const r = await run(bin('lsof'), ['-n', '-P', '-a', '-d', 'cwd', '-Fn'], { timeout: 30_000, max: 64 * 1024 * 1024 });
  // lsof exits 1 when some processes could not be read — the rest is still there; killed by the timeout, the list is partial.
  // process read «free»; and an empty list is no answer: a working lsof sees the board's own folder at least
  if (r.err && (r.err.code !== 1 || !r.out || r.err.killed || r.err.signal)) return null;
  const out = [];
  for (const line of r.out.split('\n')) if (line.startsWith('n/')) out.push(line.slice(1));
  return out.length ? out : null;
}

let picture = null; // the last walk: {at, done, total, repos, stands, running}
let flight = null;
let forcedAt = 0;

/** What is known of the stands now; a walk starts when none is known, the picture is older than STANDS_FRESH_MS, or on
    `force` (not more often than FORCE_EVERY_MS). */
// the folders of the board's projects: a project added, moved or archived since the walk makes the picture old at once
const foldersNow = () => JSON.stringify(db.prepare("SELECT path FROM projects WHERE archived = 0 AND path IS NOT NULL AND path != '' ORDER BY id").all().map((r) => r.path));
export function standsView({ force = false } = {}) {
  const old = !picture || Date.now() - picture.at > STANDS_FRESH_MS || picture.folders !== foldersNow();
  if (!flight && (old || (force && Date.now() - forcedAt > FORCE_EVERY_MS))) {
    if (force) forcedAt = Date.now();
    if (picture) picture.running = true; // the page asks again until the new walk has its picture
    flight = walk().catch((e) => { picture = { ...(picture || emptyPicture()), running: false, error: e.message }; }).finally(() => { flight = null; });
  }
  return shown(picture || { ...emptyPicture(), running: true });
}
const emptyPicture = () => ({ at: Date.now(), done: 0, total: 0, repos: [], stands: [], running: true, folders: foldersNow() });
const shown = (p) => ({ at: p.at, running: Boolean(p.running), done: p.done, total: p.total, error: p.error || null,
  repos: p.repos.map(({ log, ...r }) => r), stands: p.stands.map(({ messages, ...s }) => ({ ...s, ...standState(s) })) });
/** For a test: wait for the walk in flight. */
export const standsSettled = () => flight || Promise.resolve();
/** For a test: forget the last picture. */
export function forgetStands() { picture = null; forcedAt = 0; }

/** The repositories of the board's projects: [{top, common, projects: [{id, slug, name, prefix, path}]}]. */
async function boardRepos() {
  const projects = db.prepare('SELECT id, slug, name, prefix, path FROM projects WHERE archived = 0 AND path IS NOT NULL AND path != \'\' ORDER BY position, name COLLATE NOCASE').all();
  const byCommon = new Map();
  for (const p of projects) {
    if (!existsSync(p.path)) continue;
    const r = await git(p.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (r.err) continue;
    const common = await real(r.out.trim());
    if (!byCommon.has(common)) byCommon.set(common, { common, projects: [] });
    byCommon.get(common).projects.push(p);
  }
  return [...byCommon.values()];
}

async function walk() {
  const prefixes = new Map(db.prepare('SELECT prefix, id FROM projects').all().map((r) => [String(r.prefix).toUpperCase(), r.id]));
  const taskOf = db.prepare(`SELECT t.id, t.status, t.title, p.slug, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.prefix = ? COLLATE NOCASE AND t.task_no = ?`);
  const next = { at: Date.now(), done: 0, total: 0, repos: [], stands: [], running: true, folders: foldersNow() };
  // the folders of EVERY project of the board, as they really are: a project in a repository of its own nested inside a
  // stand (dist/sub, node_modules/x) has another git-common-dir, and `git worktree remove` takes it with the stand
  const homes = await Promise.all(db.prepare("SELECT path FROM projects WHERE archived = 0 AND path IS NOT NULL AND path != ''").all().map((p) => real(p.path)));
  for (const repo of await boardRepos()) {
    const list = await git(repo.projects[0].path, ['worktree', 'list', '--porcelain']);
    if (list.err) continue;
    const all = parseWorktrees(list.out);
    const top = all[0]?.path;
    if (!top) continue;
    const m = await mainRef(top);
    let free = null;
    try { const f = await statfs(top); free = Number(f.bavail) * Number(f.bsize); } catch { /* not known */ }
    const r = { top, main: m?.name || null, ref: m?.ref || null, free, projects: repo.projects.map(({ slug, name }) => ({ slug, name })), log: null };
    next.repos.push(r);
    // main went. A branch the repository keeps (main, master: the ones mainRef measures by; the branch of the main checkout
    // git lets no worktree hold) and a folder a project of the board lives in are never a stand to remove
    for (const w of all.slice(1)) {
      if (w.bare) continue;
      const key = keyIn([basename(w.path), w.branch], new Set(prefixes.keys()));
      const t = key ? taskOf.get(key.split('-')[0], Number(key.split('-')[1])) : null;
      const own = t ? { slug: t.slug, name: t.project_name }
        : (repo.projects.find((p) => p.path === top) || (repo.projects.length === 1 ? repo.projects[0] : null));
      const wreal = await real(w.path); // a project behind a link is compared as it really is (homes are real)
      next.stands.push({
        path: w.path, top, branch: w.branch || null, head: w.head || null, detached: Boolean(w.detached),
        locked: w.locked ? (w.locked === true ? '' : w.locked) : null, prunable: Boolean(w.prunable),
        project: own ? { slug: own.slug, name: own.name } : null, repo_name: basename(top), key,
        task: t ? { id: t.id, status: t.status, title: t.title } : null,
        read: false, dirty: null, changes: null, ignored: null, commits: null, sessions: 0, processes: 0, size: null, changed_at: null, missing: false,
        keeps: KEPT_BRANCHES.has(w.branch), home: homes.some((h) => within(w.path, h) || within(wreal, h)),
      });
    }
  }
  next.total = next.stands.length;
  // the sizes of the last walk stay on until measured anew: a stand does not jump to «—» on «Check again»
  const before = new Map((picture?.stands || []).map((s) => [s.path, s]));
  for (const s of next.stands) { const b = before.get(s.path); if (b) { s.size = b.size; s.changed_at = b.changed_at; } }
  picture = next;

  const registry = [...(await readRegistry()).values()].filter((e) => e.cwd && stateOf(e) !== 'gone');
  const sessionDirs = await Promise.all(registry.map((e) => real(e.cwd)));
  const procDirs = await processFolders();
  const logs = new Map();
  const logOf = (top, ref) => {
    if (!logs.has(top)) logs.set(top, ref ? mainLog(top, ref) : Promise.resolve({ titles: new Set(), issues: new Set(), failed: true }));
    return logs.get(top);
  };
  const reposByTop = new Map(next.repos.map((r) => [r.top, r]));
  const gits = new Map(); // top → {tree, objects} of its main, asked once per repository
  const repoOf = (top, ref) => { if (!gits.has(top)) gits.set(top, repoGit(top, ref)); return gits.get(top); };

  const one = async (s) => {
    const dir = await real(s.path);
    s.sessions = sessionDirs.filter((d) => within(dir, d)).length;
    s.processes = procDirs ? procDirs.filter((d) => within(dir, d)).length : null; // null — not known: no stand is free by it
    // no folder (deleted by hand, `prunable`): nothing in it to lose, but its branch is still compared with main below
    if (!existsSync(s.path)) { s.missing = true; s.dirty = 0; s.changes = { files: 0 }; s.ignored = { files: 0, paths: [] }; }
    // with the ignored files: `git worktree remove` takes them without asking, so a stand holding data is no free one
    const st = s.missing ? null : await git(s.path, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=normal']);
    if (!st) { /* the folder is gone */ } else if (st.err) { s.dirty = null; } else {
      const { changed, ignored } = parseStatusZ(st.out);
      s.dirty = changed.length;
      s.changes = { files: changed.length, untracked: changed.filter((l) => l.startsWith('??')).length };
      s.ignored = await keptIgnored(s.path, s.top, ignored);
    }
    const ref = reposByTop.get(s.top)?.ref; // the full ref, never the short name
    if (!ref || !s.head) { s.commits = null; return; }
    const ch = await git(s.top, ['cherry', ref, s.head]);
    if (ch.err) { s.commits = null; return; }
    const shas = ch.out.split('\n').map((l) => l.trim().slice(2)).filter(Boolean);
    const messages = new Map();
    if (shas.length) {
      const lg = await git(s.top, ['log', '--no-walk=unsorted', '--format=%H%x1f%s%x1f%b%x1e', ...shas.slice(0, 500)]);
      for (const rec of (lg.out || '').split('\x1e')) {
        const [sha, title = '', body = ''] = rec.replace(/^\n/, '').split('\x1f');
        if (sha) messages.set(sha.trim(), { title: title.trim(), body });
      }
    }
    const main = await logOf(s.top, ref);
    const plus = ch.out.split('\n').map((l) => /^\+ ([0-9a-f]{7,64})/.exec(l.trim())?.[1]).filter(Boolean);
    const merges = await ownMerges(s.top, ref, s.head, await repoOf(s.top, ref));
    if (!merges) { s.commits = null; return; }
    s.commits = [...matchCommits(ch.out, messages, main, await inMainByContent(s.top, ref, plus, await repoOf(s.top, ref))),
      ...merges.map((x) => ({ sha: x.sha, title: x.title, found: null, like: null, merge: true }))].map((c) => ({ ...c, sha: c.sha.slice(0, 12) }));
    if (s.missing) return;
    const lc = await git(s.path, ['log', '-1', '--format=%ct', 'HEAD']);
    s.changed_at = Number(lc.out?.trim()) * 1000 || null;
    try { // the index moves with every add, commit and checkout in the folder
      const gd = await git(s.path, ['rev-parse', '--path-format=absolute', '--git-dir']);
      const idx = await stat(join(gd.out.trim(), 'index'));
      s.changed_at = Math.max(s.changed_at || 0, idx.mtimeMs);
    } catch { /* the date of the commit stays */ }
  };
  await pool(next.stands, one, (s) => { s.read = true; next.done += 1; });
  // sizes last: the states are what the page needs first
  await pool(next.stands.filter((s) => !s.missing), async (s) => {
    const du = await run(bin('du'), ['-sk', s.path], { timeout: DU_MS });
    const kb = Number((du.out || '').split(/\s/)[0]);
    if (Number.isFinite(kb) && kb > 0) s.size = kb * 1024;
  });
  next.running = false;
  next.at = Date.now();
}

async function pool(items, fn, after = () => {}) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch { /* one stand that could not be read stays unread */ }
      after(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
}

/** A stand of the last picture by its folder — the only folders the routes below may name. */
export const knownStand = (path) => picture?.stands.find((s) => s.path === path) || null;

// the headings of a diff in the language of the board
const DIFF_WORDS = {
  en: { dirty: '# not committed', untracked: '# untracked', ignored: '# ignored, and not in the main checkout — a removal deletes these', more: (n) => `… and ${n} more`, cut: (n) => `… (cut at ${n} characters)` },
  ru: { dirty: '# не закоммичено', untracked: '# не отслеживается git', ignored: '# игнорируется, и в основном чекауте этого нет — удаление сотрёт эти файлы', more: (n) => `… и ещё ${n}`, cut: (n) => `… (обрезано на ${n} знаках)` },
};
/** What of a stand is not in main, for the eyes of the owner: the patches of its commits found nowhere in main (a merge —
    against the clean merge of its parents, `--remerge-diff`: its own changes, not the whole of main it brought in), then
    the changes not committed — capped at DIFF_MAX characters. The headings in the language of the board (`lang`). */
export async function standDiff(path, lang = 'en') {
  const s = knownStand(path);
  if (!s) return null;
  const words = DIFF_WORDS[lang === 'ru' ? 'ru' : 'en'];
  const parts = [];
  const lost = (s.commits || []).filter((c) => !c.found).map((c) => c.sha);
  if (lost.length) {
    const r = await git(s.top, ['show', '--remerge-diff', '--stat', '--patch', '--format=commit %H%n%s%n', ...lost.slice(0, 50)], { max: 64 * 1024 * 1024 });
    parts.push(r.out);
  }
  if (s.dirty && existsSync(s.path)) {
    const r = await git(s.path, ['diff', 'HEAD', '--stat', '--patch'], { max: 64 * 1024 * 1024 });
    const u = await git(s.path, ['ls-files', '--others', '--exclude-standard']);
    parts.push(`${words.dirty}\n${r.out}${u.out.trim() ? `\n${words.untracked}\n${u.out}` : ''}`);
  }
  if (s.ignored?.files) {
    parts.push(`${words.ignored}\n${s.ignored.paths.join('\n')}${s.ignored.files > s.ignored.paths.length ? `\n${words.more(s.ignored.files - s.ignored.paths.length)}` : ''}\n`);
  }
  const text = parts.join('\n');
  return { text: text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n${words.cut(DIFF_MAX)}` : text, cut: text.length > DIFF_MAX };
}

/* The task of the cleanup: one per repository, in the project of most of its chosen stands. Its Claude checks each stand
   again right before removing it — the picture may be minutes old, and a session may have opened in a folder since. */
const TITLES = { ru: 'Убрать старые стенды', en: 'Remove old stands' };
const WHY_WORDS = {
  en: { locked: 'the worktree is locked', unknown: 'could not tell what is in it', dirty: 'not committed', ignored: 'ignored data not in the main checkout', commits: 'commits not in main', merge: 'a merge with changes of its own', detached: 'detached HEAD with commits of its own' },
  ru: { locked: 'рабочая копия заперта', unknown: 'не удалось понять, что в ней', dirty: 'есть незакоммиченное', ignored: 'игнорируемые данные, которых нет в основном чекауте', commits: 'коммиты, которых нет в main', merge: 'слияние со своими правками', detached: 'отделённый HEAD со своими коммитами' },
};
export const STAND_TITLES = TITLES;
export function cleanupWords(lang, repo, chosen, unsent) {
  const ref = repo.ref || 'refs/remotes/origin/main'; // the full ref: a local branch named «origin/main» would win over the short name
  const fetch = ref.startsWith('refs/remotes/origin/'); // a repository without origin is measured against its own main: no fetch there
  const en = lang === 'en';
  const gone = en ? ' · no folder: `git worktree remove <folder>` drops its record alone (not `git worktree prune`: it drops every such record of the repository)'
    : ' · папки нет: `git worktree remove <папка>` уберёт только её запись (не `git worktree prune`: он убирает все такие записи репозитория)';
  const size = (n) => {
    if (!n) return '';
    const big = n >= 1024 ** 3;
    const num = big ? (n / 1024 ** 3).toFixed(1) : String(Math.max(1, Math.round(n / 1024 ** 2)));
    return ` · ${en ? num : num.replace('.', ',')} ${big ? (en ? 'GB' : 'ГБ') : (en ? 'MB' : 'МБ')}`;
  };
  const list = chosen.map((s) => `- ${s.path} — ${s.branch ? `${en ? 'branch' : 'ветка'} ${s.branch}` : (en ? 'detached HEAD' : 'отделённый HEAD')}${s.head ? ` @ ${s.head.slice(0, 12)}` : ''}${size(s.size)}${s.missing ? gone : ''}`).join('\n');
  const words = WHY_WORDS[en ? 'en' : 'ru'];
  const asks = unsent.map((s) => `- ${s.path}${s.branch ? ` (${s.branch})` : ''}: ${standState(s).why.map((w) => words[w] || w).join(', ')}`).join('\n');
  if (en) {
    return `Remove the old stands (git worktrees) of ${repo.top}, chosen in Health → Stands: ${chosen.length}.\n\n${list}\n\n`
      + 'For EACH stand, right before removing it, check all four again — skip it and say why if any fails:\n'
      + '1. nothing uncommitted or untracked: `git -C <folder> status --porcelain` is empty;\n'
      + '2. no ignored data: `git worktree remove` deletes ignored files without asking. Every path of `git -c core.quotePath=false -C <folder> status --porcelain --ignored` (names as they are, Cyrillic too) marked «!!» is what a build or an install makes again (node_modules, dist, build, __pycache__, .venv, .DS_Store, package-lock.json…), `.claude/settings.local.json` or `.claude/launch.json`, or a file the main checkout holds with the same bytes (`cmp <folder>/<path> ' + repo.top + '/<path>`); anything else — a `.env`, `data/`, `var/`, a database — keep the stand and name the files. '
      + 'A path ending in «/» is a whole folder (`!! .claude/`): unless its own name is one of those made again, look at its files one by one — `git -c core.quotePath=false -C <folder> status --porcelain --ignored --untracked-files=all -- <path>`;\n'
      + `3. every commit of the branch is in ${ref}: ${fetch ? '`git fetch origin`, then ' : ''}\`git cherry ${ref} <branch>\`; a «+» commit counts only if main already holds its changes — \`git merge-tree --write-tree --merge-base=<sha>^ ${ref} <sha>\` prints the tree of \`git rev-parse ${ref}^{tree}\`, and only if it changes something: a commit whose tree is its parent's (\`git rev-parse <sha>^{tree} <sha>^^{tree}\` prints one tree twice) merges to main's tree anyway and proves nothing. `
      + `git cherry passes merges over: each merge of \`git rev-list --merges --parents ${ref}..<branch>\` (its sha, then its parents) counts only with two parents and \`git merge-tree --write-tree <parent1> <parent2>\` printing its own tree (\`git rev-parse <sha>^{tree}\`); a conflict or another tree — a merge with changes of its own, keep the stand. `
      + 'The same title or issue number in the log of main is no proof: every commit of a task carries its issue;\n'
      + '4. not busy: no Claude session and no process in the folder (`lsof +D <folder>`; it sees only the processes of your user — a server started as root goes unseen), the task of its key is not in prep/doing/ready/deploy, the branch is not main, master or the branch of the main checkout, no project of the board lives in the folder or below it.\n\n'
      + 'Then `git worktree remove <folder>` (never --force) and `git branch -d <branch>` (never -D; refused — leave the branch and say so). '
      + 'Do not touch the main checkout, the branch main, other projects or the stash.\n\n'
      + 'In the report: per stand — removed or kept and why, and the last commit of each removed branch (`<sha> <branch>`): it lives on in the reflog and can be brought back with `git branch <branch> <sha>`.'
      + (asks ? `\n\nNot in this task — work not in main, ask the owner what to do with each:\n${asks}` : '')
      + '\n\nThe board opened this task: Health → Stands.';
  }
  return `Убрать старые стенды (рабочие копии git) в ${repo.top}, выбранные в «Здоровье → Стенды»: ${chosen.length}.\n\n${list}\n\n`
    + 'По КАЖДОМУ стенду прямо перед удалением ещё раз проверить все четыре условия — не прошло хоть одно, стенд не трогать и сказать почему:\n'
    + '1. нет незакоммиченного и неотслеживаемого: `git -C <папка> status --porcelain` пуст;\n'
    + '2. нет игнорируемых данных: `git worktree remove` удаляет игнорируемые файлы без вопроса. Каждый путь с «!!» в `git -c core.quotePath=false -C <папка> status --porcelain --ignored` (имена как есть, и кириллица) — то, что сборка или установка сделают заново (node_modules, dist, build, __pycache__, .venv, .DS_Store, package-lock.json…), `.claude/settings.local.json` или `.claude/launch.json`, либо файл, который основной чекаут держит теми же байтами (`cmp <папка>/<путь> ' + repo.top + '/<путь>`); что-то другое — `.env`, `data/`, `var/`, база — стенд оставить и назвать файлы. '
    + 'Путь с «/» на конце — папка целиком (`!! .claude/`): если её собственное имя не из тех, что делаются заново, смотреть её файлы по одному — `git -c core.quotePath=false -C <папка> status --porcelain --ignored --untracked-files=all -- <путь>`;\n'
    + `3. каждый коммит ветки есть в ${ref}: ${fetch ? '`git fetch origin`, затем ' : ''}\`git cherry ${ref} <ветка>\`; коммит с «+» считается, только если его правки в main уже есть — \`git merge-tree --write-tree --merge-base=<sha>^ ${ref} <sha>\` печатает дерево \`git rev-parse ${ref}^{tree}\`, и только если он что-то меняет: коммит с деревом своего родителя (\`git rev-parse <sha>^{tree} <sha>^^{tree}\` печатает одно дерево дважды) сливается в дерево main всегда и ничего не доказывает. `
    + `Слияния git cherry пропускает: каждое слияние из \`git rev-list --merges --parents ${ref}..<ветка>\` (его sha, затем родители) считается, только если родителей два и \`git merge-tree --write-tree <родитель1> <родитель2>\` печатает его же дерево (\`git rev-parse <sha>^{tree}\`); конфликт или другое дерево — слияние со своими правками, стенд оставить. `
    + 'Тот же заголовок или номер issue в логе main — не доказательство: номер своей задачи несёт каждый её коммит;\n'
    + '4. не занят: в папке нет сессии Claude и процесса (`lsof +D <папка>`; он видит только процессы своего пользователя — сервер, запущенный от root, не виден), задача ключа не в prep/doing/ready/deploy, ветка — не main, не master и не ветка основного чекаута, в папке и глубже не живёт проект доски.\n\n'
    + 'Затем `git worktree remove <папка>` (без --force) и `git branch -d <ветка>` (не -D; отказал — ветку оставить и сказать). '
    + 'Основной чекаут, ветку main, чужие проекты и stash не трогать.\n\n'
    + 'В отчёте: по каждому стенду — удалён или оставлен и почему, и последний коммит каждой удалённой ветки (`<sha> <ветка>`): она ещё живёт в reflog, вернуть — `git branch <ветка> <sha>`.'
    + (asks ? `\n\nНе в этой задаче — работа, которой нет в main, спросить владельца, что делать с каждым:\n${asks}` : '')
    + '\n\nЗадачу завела доска: «Здоровье → Стенды».';
}

/** The tasks of a cleanup of `paths` (folders of the last picture): only stands `free` by it; one task per repository —
    the open one of the same title in that project (Backlog/To do: its description is written anew), else a new one in To
    do. [{key, project, n}] or {code, error, reason}. */
export function cleanupProject(repo, chosen, all) {
  const here = new Set(repo.projects.map((p) => p.slug));
  const most = (list) => {
    const count = new Map();
    for (const s of list) if (s.project && here.has(s.project.slug)) count.set(s.project.slug, (count.get(s.project.slug) || 0) + 1);
    let best = null;
    for (const p of repo.projects) if (count.get(p.slug) > (count.get(best) || 0)) best = p.slug; // a tie — the order of the board
    return best;
  };
  return most(chosen) || most(all) || repo.projects[0].slug;
}

export async function cleanupTasks(app, paths, lang, headers) {
  if (!picture) return { code: 409, reason: 'not-walked', error: 'the stands have not been looked at yet' };
  const want = new Set(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []);
  const shownNow = shown(picture).stands;
  const chosen = shownNow.filter((s) => want.has(s.path) && s.state === 'free');
  if (!chosen.length) return { code: 409, reason: 'nothing-free', error: 'none of the chosen stands can be removed' };
  const byTop = new Map();
  for (const s of chosen) { if (!byTop.has(s.top)) byTop.set(s.top, []); byTop.get(s.top).push(s); }
  // one cleanup a repository, whichever of its projects holds it: two Claudes removing worktrees of one repository at once
  // would race. All are looked at before any task is written — a refusal for the second must not lose the first one's task
  const openOf = db.prepare(`SELECT p.slug, p.prefix || '-' || t.task_no AS key, t.status FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.slug IN (SELECT value FROM json_each(?)) AND t.title IN (?, ?) AND t.status NOT IN ('done', 'cancelled') ORDER BY t.id DESC LIMIT 1`);
  const plan = [];
  for (const [top, list] of byTop) {
    const repo = picture.repos.find((r) => r.top === top);
    const open = openOf.get(JSON.stringify(repo.projects.map((p) => p.slug)), TITLES.ru, TITLES.en);
    if (open && !['backlog', 'todo'].includes(open.status)) {
      return { code: 409, reason: 'cleanup-open', key: open.key, error: `a cleanup of these stands is already ${open.status === 'review' ? 'waiting for your review' : 'in work'}: ${open.key}` };
    }
    plan.push({ repo, list, open, slug: open?.slug || cleanupProject(repo, list, shownNow.filter((s) => s.top === top)) });
  }
  const out = [];
  for (const { repo, list, open, slug } of plan) {
    const description = cleanupWords(lang, repo, list, shownNow.filter((s) => s.top === repo.top && s.state === 'unsent'));
    let key;
    if (open) {
      const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${encodeURIComponent(open.key)}`, headers, payload: { description, status: 'todo' } });
      if (res.statusCode >= 300) return { code: res.statusCode, error: res.json?.().error || 'could not update the task' };
      key = open.key;
    } else {
      const res = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { project: slug, title: TITLES[lang === 'en' ? 'en' : 'ru'], description, status: 'todo' } });
      if (res.statusCode >= 300) return { code: res.statusCode, error: res.json().error || 'could not open the task' };
      key = res.json().key;
    }
    out.push({ key, project: slug, n: list.length });
  }
  return { tasks: out };
}
