
import { execFile } from 'node:child_process';
import { realpath, stat, statfs } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { db } from './db.js';
import { readRegistry, stateOf } from './claude-live.js';
import { bin } from './bin-path.js';

const GIT_MS = 20_000;
const DU_MS = 120_000;
const AT_ONCE = 4; // folders walked side by side
export const STANDS_FRESH_MS = 10 * 60_000; // an older picture is walked again on the next look
export const FORCE_EVERY_MS = 15_000; // «Check again» — not more often
const WORK = new Set(['prep', 'doing', 'ready', 'deploy']);
const DIFF_MAX = 200_000;

const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
function run(cmd, args, { cwd, timeout = GIT_MS, max = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: max, env }, (err, out) => resolve(err ? { err, out: String(out || '') } : { out: String(out) }));
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
/** How the commits of a branch stand against main: each commit {sha, title, found: 'patch'|'title'|'issue'|null}.
    `cherry` — the lines of `git cherry <main> <head>` («+ sha» not in main as a patch, «- sha» is); `main` — {titles: Set,
    issues: Set} of the log of main; `messages` — sha → {title, body}. Pure. */
export function matchCommits(cherry, messages, main) {
  const out = [];
  for (const line of String(cherry).split('\n')) {
    const m = /^([+-]) ([0-9a-f]{7,64})/.exec(line.trim());
    if (!m) continue;
    const msg = messages.get(m[2]) || { title: '', body: '' };
    let found = null;
    if (m[1] === '-') found = 'patch';
    else if (telling(msg.title) && main.titles.has(msg.title)) found = 'title';
    else {
      const issues = issuesIn(`${msg.title}\n${msg.body}`);
      if (issues.length && issues.every((n) => main.issues.has(n))) found = 'issue';
    }
    out.push({ sha: m[2], title: msg.title, found });
  }
  return out;
}

/** The state of a stand from what was read of it. Pure: {state: 'reading'|'busy'|'unsent'|'free', why: [words…]}. */
export function standState(s) {
  if (s.read === false) return { state: 'reading', why: [] }; // the walk has not come to it yet
  const why = [];
  if (s.sessions) why.push('session');
  if (s.processes) why.push('process');
  if (s.task && WORK.has(s.task.status)) why.push('task');
  if (why.length) return { state: 'busy', why };
  if (s.locked) why.push('locked');
  if (s.dirty === null || s.commits === null || s.processes === null) why.push('unknown'); // git or lsof did not answer, or no main to measure by
  if (s.dirty) why.push('dirty');
  if (s.commits?.some((c) => !c.found)) why.push('commits');
  if (s.detached && s.commits?.length) why.push('detached');
  if (why.length) return { state: 'unsent', why };
  return { state: 'free', why: [] };
}

/** The main branch of the origin to measure against: origin/main, origin/master, else the local main/master; null. */
async function mainRef(top) {
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    const r = await git(top, ['rev-parse', '--verify', '--quiet', ref]);
    if (!r.err && r.out.trim()) return ref.replace(/^refs\/(remotes|heads)\//, '');
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
  // lsof exits 1 when some processes could not be read — the rest is still there; killed by the timeout, the list is partial
  if (r.err && (!r.out || r.err.killed || r.err.signal)) return null;
  const out = [];
  for (const line of r.out.split('\n')) if (line.startsWith('n/')) out.push(line.slice(1));
  return out;
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
  for (const repo of await boardRepos()) {
    const list = await git(repo.projects[0].path, ['worktree', 'list', '--porcelain']);
    if (list.err) continue;
    const all = parseWorktrees(list.out);
    const top = all[0]?.path;
    if (!top) continue;
    const ref = await mainRef(top);
    let free = null;
    try { const f = await statfs(top); free = Number(f.bavail) * Number(f.bsize); } catch { /* not known */ }
    const r = { top, main: ref, free, projects: repo.projects.map(({ slug, name }) => ({ slug, name })), log: null };
    next.repos.push(r);
    for (const w of all.slice(1)) {
      if (w.bare) continue;
      const key = keyIn([basename(w.path), w.branch], new Set(prefixes.keys()));
      const t = key ? taskOf.get(key.split('-')[0], Number(key.split('-')[1])) : null;
      // the project of the stand: its key's, else the project of the repository whose folder is its top, else the first
      const own = (t && repo.projects.find((p) => p.slug === t.slug)) || repo.projects.find((p) => p.path === top) || repo.projects[0];
      next.stands.push({
        path: w.path, top, branch: w.branch || null, head: w.head || null, detached: Boolean(w.detached),
        locked: w.locked ? (w.locked === true ? '' : w.locked) : null, prunable: Boolean(w.prunable),
        project: { slug: own.slug, name: own.name }, key,
        task: t ? { id: t.id, status: t.status, title: t.title } : null,
        read: false, dirty: null, changes: null, commits: null, sessions: 0, processes: 0, size: null, changed_at: null, missing: false,
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

  const one = async (s) => {
    const dir = await real(s.path);
    s.sessions = sessionDirs.filter((d) => within(dir, d)).length;
    s.processes = procDirs ? procDirs.filter((d) => within(dir, d)).length : null; // null — not known: no stand is free by it
    // no folder (deleted by hand, `prunable`): nothing in it to lose, but its branch is still compared with main below
    if (!existsSync(s.path)) { s.missing = true; s.dirty = 0; s.changes = { files: 0 }; }
    const st = s.missing ? null : await git(s.path, ['status', '--porcelain', '--untracked-files=normal']);
    if (!st) { /* the folder is gone */ } else if (st.err) { s.dirty = null; } else {
      const lines = st.out.split('\n').filter(Boolean);
      s.dirty = lines.length;
      s.changes = { files: lines.length, untracked: lines.filter((l) => l.startsWith('??')).length };
    }
    const ref = reposByTop.get(s.top)?.main;
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
    s.commits = matchCommits(ch.out, messages, main).map((c) => ({ ...c, sha: c.sha.slice(0, 12) }));
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

/** What of a stand is not in main, for the eyes of the owner: the patches of its commits found nowhere in main, then the
    changes not committed — capped at DIFF_MAX characters. */
export async function standDiff(path) {
  const s = knownStand(path);
  if (!s) return null;
  const parts = [];
  const lost = (s.commits || []).filter((c) => !c.found).map((c) => c.sha);
  if (lost.length) {
    const r = await git(s.top, ['show', '--stat', '--patch', '--format=commit %H%n%s%n', ...lost.slice(0, 50)], { max: 64 * 1024 * 1024 });
    parts.push(r.out);
  }
  if (s.dirty && existsSync(s.path)) {
    const r = await git(s.path, ['diff', 'HEAD', '--stat', '--patch'], { max: 64 * 1024 * 1024 });
    const u = await git(s.path, ['ls-files', '--others', '--exclude-standard']);
    parts.push(`# not committed\n${r.out}${u.out.trim() ? `\n# untracked\n${u.out}` : ''}`);
  }
  const text = parts.join('\n');
  return { text: text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n… (cut at ${DIFF_MAX} characters)` : text, cut: text.length > DIFF_MAX };
}

/* The task of the cleanup: one per repository, in the project of most of its chosen stands. Its Claude checks each stand
   again right before removing it — the picture may be minutes old, and a session may have opened in a folder since. */
const TITLES = { ru: 'Убрать старые стенды', en: 'Remove old stands' };
export const STAND_TITLES = TITLES;
const gb = (n) => (n ? `${(n / 1024 ** 3).toFixed(1)} GB` : '?');
export function cleanupWords(lang, repo, chosen, unsent) {
  const list = chosen.map((s) => `- ${s.path} — ${s.branch ? `branch ${s.branch}` : 'detached HEAD'}${s.head ? ` @ ${s.head.slice(0, 12)}` : ''}${s.size ? ` · ${gb(s.size)}` : ''}${s.missing ? ' · no folder: `git worktree prune`' : ''}`).join('\n');
  const asks = unsent.map((s) => `- ${s.path}${s.branch ? ` (${s.branch})` : ''}: ${standState(s).why.join(', ')}`).join('\n');
  if (lang === 'en') {
    return `Remove the old stands (git worktrees) of ${repo.top}, chosen in Health → Stands: ${chosen.length}.\n\n${list}\n\n`
      + 'For EACH stand, right before removing it, check all three again — skip it and say why if any fails:\n'
      + '1. nothing uncommitted or untracked: `git -C <folder> status --porcelain` is empty;\n'
      + `2. every commit of the branch is in ${repo.main || 'origin/main'}: \`git fetch origin\`, then \`git cherry ${repo.main || 'origin/main'} <branch>\`; a «+» commit counts only if the same title or the same issue number is in \`git log ${repo.main || 'origin/main'}\` — otherwise it is work not handed in;\n`
      + '3. not busy: no Claude session and no process in the folder (`lsof +D <folder>`), the task of its key is not in prep/doing/ready/deploy.\n\n'
      + 'Then `git worktree remove <folder>` (never --force) and `git branch -d <branch>` (never -D; refused — leave the branch and say so). '
      + 'Do not touch the main checkout, the branch main, other projects or the stash.\n\n'
      + 'In the report: per stand — removed or kept and why, and the last commit of each removed branch (`<sha> <branch>`): it lives on in the reflog and can be brought back with `git branch <branch> <sha>`.'
      + (asks ? `\n\nNot in this task — work not in main, ask the owner what to do with each:\n${asks}` : '')
      + '\n\nThe board opened this task: Health → Stands.';
  }
  return `Убрать старые стенды (рабочие копии git) в ${repo.top}, выбранные в «Здоровье → Стенды»: ${chosen.length}.\n\n${list}\n\n`
    + 'По КАЖДОМУ стенду прямо перед удалением ещё раз проверить все три условия — не прошло хоть одно, стенд не трогать и сказать почему:\n'
    + '1. нет незакоммиченного и неотслеживаемого: `git -C <папка> status --porcelain` пуст;\n'
    + `2. каждый коммит ветки есть в ${repo.main || 'origin/main'}: \`git fetch origin\`, затем \`git cherry ${repo.main || 'origin/main'} <ветка>\`; коммит с «+» считается, только если тот же заголовок или тот же номер issue есть в \`git log ${repo.main || 'origin/main'}\` — иначе это несданная работа;\n`
    + '3. не занят: в папке нет сессии Claude и процесса (`lsof +D <папка>`), задача ключа не в prep/doing/ready/deploy.\n\n'
    + 'Затем `git worktree remove <папка>` (без --force) и `git branch -d <ветка>` (не -D; отказал — ветку оставить и сказать). '
    + 'Основной чекаут, ветку main, чужие проекты и stash не трогать.\n\n'
    + 'В отчёте: по каждому стенду — удалён или оставлен и почему, и последний коммит каждой удалённой ветки (`<sha> <ветка>`): она ещё живёт в reflog, вернуть — `git branch <ветка> <sha>`.'
    + (asks ? `\n\nНе в этой задаче — работа, которой нет в main, спросить владельца, что делать с каждым:\n${asks}` : '')
    + '\n\nЗадачу завела доска: «Здоровье → Стенды».';
}

/** The tasks of a cleanup of `paths` (folders of the last picture): only stands `free` by it; one task per repository —
    the open one of the same title in that project (Backlog/To do: its description is written anew), else a new one in To
    do. [{key, project, n}] or {code, error, reason}. */
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
    const count = new Map();
    for (const s of list) count.set(s.project.slug, (count.get(s.project.slug) || 0) + 1);
    plan.push({ repo, list, open, slug: open?.slug || [...count].sort((a, b) => b[1] - a[1])[0][0] });
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
