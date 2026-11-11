import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db, ghOwner, ghRepo } from './db.js';
import { repoHttpsBase } from './repo-base.js';
import { bin } from './bin-path.js';

const KEEP_MS = 30_000;
const MAIN_SCAN = 3000;   // commits of main read: older ones are long shipped
const SIDE_SCAN = 1000;
const GIT_MS = 8000;
const SEP = '\x1e';
const KEY = /(?<![A-Za-z0-9])[A-Za-z0-9]+-\d+/g;
const NUMBER = /(?<![\w./-])(?:[\w.-]+\/[\w.-]+)?#\d+/g; // owner/repo#N or #N
const KEY_LIST = /^[^\p{L}\p{N}]*(?:and|\u0438)?[^\p{L}\p{N}]*$/iu; // what stands between two keys of one list

/** git's output, null when it failed. `unsure` (an object) gets `failed = true` when git did not answer at all — killed by
    GIT_MS, not started — rather than said no: such an answer is not kept (`keptLine`). */
function git(path, args, env = {}, unsure = null) {
  return new Promise((done) => {
    execFile(bin('git'), ['-C', path, ...args], { timeout: GIT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, out) => {
        if (err && unsure && (err.killed || typeof err.code !== 'number')) unsure.failed = true;
        done(err ? null : out);
      });
  });
}

/** The keys a subject claims for itself, not all it names: the first list of them. «SHI-108 follow-up to SHI-107» is a commit
    of SHI-108, «VT-572, VT-412 (acceptance of VT-627)» of the two. `known` — the prefixes of the board, in capitals: «2-3» and
    «sha-256» have a key's shape and are not keys, and standing first they took the place of the real one. Pure. */
export function ownKeys(subject, known = null) {
  const hits = [...subject.matchAll(KEY)].filter((h) => !known || known.has(h[0].split('-')[0].toUpperCase()));
  if (!hits.length) return [];
  const keys = [hits[0][0]];
  for (let i = 0; hits[i + 1] && KEY_LIST.test(subject.slice(hits[i].index + hits[i][0].length, hits[i + 1].index)); i += 1) keys.push(hits[i + 1][0]);
  return keys;
}

/** Commits of a `git log` with FORMAT: [{hash, tip, subject, words}]. `tip` — the ref it was reached by (`--source`), `words` —
    the keys its subject claims and the numbers of its message, in capitals. Pure. */
const FORMAT = `%H%n%S%n%s%n%B${SEP}`;
export const LOG_FORMAT = FORMAT;
export function parseLog(out, known = null) {
  return String(out || '').split(SEP).map((c) => c.replace(/^\n/, '')).filter(Boolean).map((c) => {
    const [hash, tip = '', subject = ''] = c.split('\n', 3);
    return { hash, tip, subject, words: new Set([...ownKeys(subject, known), ...(c.slice(hash.length + tip.length + 1).match(NUMBER) || [])].map((w) => w.toUpperCase())) };
  });
}

/** What names a task in a message. `#N` of a foreign repository is its own pull request («Merge pull request #4242»), so a
    number counts with the name of the mirror, and bare only in the repository that is the mirror. Pure. */
export function wordsOf(key, issue, mirror, home) {
  return [key, ...(issue && mirror ? [`${mirror}#${issue}`, ...(home ? [`#${issue}`] : [])] : [])].map((w) => w.toUpperCase());
}

/** Where task `t` {words, branch} stands. `branch`: 'ahead' — its own branch holds what main has not, 'in' — all it holds is
    on main, null — no such branch, or one with no commits of its own. `onMain(c)` — this side commit stands on main. Pure. */
export function placeOf(t, main, side, onMain) {
  const mine = (c) => t.words.some((w) => c.words.has(w));
  if (t.branch === 'ahead' || side.some((c) => mine(c) && !onMain(c))) return 'branch';
  return t.branch === 'in' || main.some(mine) || side.some(mine) ? 'main' : 'none';
}

export const STAT_FORMAT = `%H%n%ct %P%n%s%n%B${SEP}`;
export function statCommit(out, words, { issue = null, since = null, known = null } = {}) {
  const commits = parseLog(out, known); // `tip` holds the commit time and the parents here
  const own = commits.find((c) => words.some((w) => c.words.has(w)));
  if (own || issue || since == null) return own?.hash || null;
  const head = commits[0];
  const [time, ...parents] = (head?.tip || '').split(' ').filter(Boolean);
  if (!head || Number(time) < since || ownKeys(head.subject, known).length || parents.length > 1) return null;
  return head.hash;
}

export function namesTask(out, words, { issue = null, known = null } = {}) {
  const commits = parseLog(out, known);
  if (!commits.length) return true;
  return commits.some((c) => words.some((w) => c.words.has(w)) || (!issue && !ownKeys(c.subject, known).length));
}

export function branchesOf(key, names) {
  const k = new RegExp(`(^|[-/_])${key}($|[-/_])`, 'i');
  return names.filter((n) => k.test(n.replace(/^(origin\/)?claude\//, '')));
}

/** What `git cherry` says of a branch against main: 'ahead', 'in', or null when it has no commit of its own. Pure. */
export function cherryState(out) {
  const lines = String(out || '').split('\n').filter(Boolean);
  if (!lines.length) return null;
  return lines.some((l) => l.startsWith('+')) ? 'ahead' : 'in';
}
const cherryCopies = (out) => new Set(String(out || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)));

/** A path for GIT_ALTERNATE_OBJECT_DIRECTORIES, which splits on a colon unless the entry is quoted. */
export const alternate = (p) => (/[:"\\]/.test(p) ? `"${p.replace(/["\\]/g, '\\$&')}"` : p);

/** Whether a line ahead by patches is squashed into main: merging it leaves main's tree as it is, and it does change something
    (a line that took its work back merges the same way, with nothing on main). Git before 2.38 has no `--write-tree`, and a
    conflict is not proof: neither is squashed. `--write-tree` puts the trees it makes into the objects of the repository, and
    a look at a card must not grow the person's repository: `shelf` sends them to a directory of the look, reading through to
    the real objects. */
async function squashed(path, ref, tree, tip, objects, unsure) {
  if (objects === null) return false;
  const scratch = await mkdtemp(join(tmpdir(), 'kb-ship-')).catch(() => null); // none: a squash is not seen, the rest stands
  if (!scratch) return false;
  try {
    const merged = await git(path, ['merge-tree', '--write-tree', ref, tip], { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(objects) }, unsure);
    if (merged === null || merged.split('\n')[0].trim() !== tree) return false;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return Boolean((await git(path, ['diff', '--name-only', `${ref}...${tip}`], {}, unsure))?.trim());
}

async function sideLine(path, ref, tree, tip, objects) {
  if ((await git(path, ['rev-list', '--count', `${ref}..${tip}`]))?.trim() === '0') return { state: null, copies: new Set() };
  const unsure = { failed: false };
  const out = await git(path, ['cherry', ref, tip], {}, unsure);
  if (out === null) unsure.failed = true; // a line with commits of its own says something: no answer is a failure
  const state = cherryState(out);
  const squash = state === 'ahead' && await squashed(path, ref, tree, tip, objects, unsure);
  return { state: squash ? 'in' : state, copies: cherryCopies(out), failed: unsure.failed };
}

async function mainRef(path) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) !== null) return ref;
  }
  return null;
}

/** `owner/repo` of the mirror of issues: `gh.repo` holds either the whole name or the part after the owner. */
export function mirrorName(owner, repo) {
  return !repo ? '' : repo.includes('/') ? repo : owner ? `${owner}/${repo}` : '';
}

const LINE_IDLE_MS = 10 * 60_000;
const linesKept = new Map(); // `${main}..${tip}` (hashes) → {used, value (a promise)}
function keptLine(path, main, tip, tree, objects, now = Date.now()) {
  const id = `${main}..${tip}`;
  const had = linesKept.get(id);
  if (had) { had.used = now; return had.value; }
  const value = sideLine(path, main, tree, tip, objects);
  linesKept.set(id, { used: now, value });
  value.then((line) => { if (line.failed && linesKept.get(id)?.value === value) linesKept.delete(id); }); // asked again next look
  for (const [k, v] of linesKept) if (now - v.used >= LINE_IDLE_MS) linesKept.delete(k);
  return value;
}

/** What a look needs of the repository a project lives in, read once for every project of it while it lives KEEP_MS:
    {main, side, names, base, line(tip)}; null — no git there, or no main. `line` answers a side line by the hashes of main
    and of the tip (`keptLine`). */
async function readRepo(path) {
  const ref = await mainRef(path);
  if (!ref) return null;
  const [mainLog, sideLog, refs, heads, tree, objects, base] = await Promise.all([
    git(path, ['log', ref, '-n', String(MAIN_SCAN), `--format=${FORMAT}`]),
    git(path, ['log', '--source', '--no-merges', '--branches', '--remotes', '--not', ref, '-n', String(SIDE_SCAN), `--format=${FORMAT}`]),
    git(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/claude', 'refs/remotes/origin/claude']),
    git(path, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads', 'refs/remotes']),
    git(path, ['rev-parse', `${ref}^{commit}`, `${ref}^{tree}`]),
    git(path, ['rev-parse', '--git-path', 'objects']),
    repoHttpsBase(path),
  ]);
  if (mainLog === null || sideLog === null) return null;
  const known = new Set(db.prepare('SELECT upper(prefix) AS prefix FROM projects').all().map((p) => p.prefix));
  const [mainAt = '', top = ''] = String(tree || '').trim().split('\n');
  const store = objects === null ? null : resolve(path, objects.trim());
  const at = new Map(String(heads || '').split('\n').filter(Boolean).map((l) => l.split(' ')));
  const lines = new Map();
  const line = (tip) => (at.has(tip) && mainAt ? keptLine(path, mainAt, at.get(tip), top, store) : sideLine(path, ref, top, tip, store));
  return {
    main: parseLog(mainLog, known), side: parseLog(sideLog, known),
    names: String(refs || '').split('\n').filter(Boolean), base,
    line: (tip) => { if (!lines.has(tip)) lines.set(tip, line(tip)); return lines.get(tip); },
  };
}

const repos = new Map(); // the common git directory of a repository → {at, value (a promise)}
/** The repository of `path`, shared by every project in it (a folder of it, a worktree of it). */
async function repoOf(path, now = Date.now()) {
  const common = await git(path, ['rev-parse', '--git-common-dir']); // relative to `path`, or absolute
  if (common === null) return null;
  const id = resolve(path, common.trim());
  const had = repos.get(id);
  if (had && now - had.at < KEEP_MS) return had.value;
  const value = readRepo(path).catch(() => null);
  repos.set(id, { at: now, value });
  for (const [k, v] of repos) if (now - v.at >= KEEP_MS) repos.delete(k);
  return value;
}

async function look(project) {
  const tasks = db.prepare(`SELECT t.id, p.prefix || '-' || t.task_no AS key, t.gh_issue_number AS issue, t.labels FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN ('ready', 'review')`).all(project.id)
    .filter((t) => !/"(noclaude|check)"/.test(t.labels || ''));
  if (!tasks.length || !project.path) return {};
  const repo = await repoOf(project.path);
  if (!repo) return {}; // no git here, or no main: the card says nothing
  const { main, side, names, base } = repo;
  const mirror = mirrorName(ghOwner(), ghRepo());
  const home = Boolean(mirror) && base?.toLowerCase() === `https://github.com/${mirror}`.toLowerCase();
  const plans = tasks.map((t) => ({ key: t.key, words: wordsOf(t.key, t.issue, mirror, home), branches: branchesOf(t.key, names) }));
  // only the lines that hold a task of these columns: a repository may have hundreds of others
  const tips = new Set(plans.flatMap((t) => [...t.branches, ...side.filter((c) => t.words.some((w) => c.words.has(w))).map((c) => c.tip)]));
  const lines = new Map();
  for (const tip of tips) lines.set(tip, await repo.line(tip)); // one by one: this is a hint, not worth the cores
  const onMain = (c) => lines.get(c.tip)?.state === 'in' || Boolean(lines.get(c.tip)?.copies.has(c.hash));
  const out = {};
  for (const t of plans) {
    const states = t.branches.map((b) => lines.get(b).state);
    const branch = states.includes('ahead') ? 'ahead' : states.includes('in') ? 'in' : null;
    out[t.key] = placeOf({ words: t.words, branch }, main, side, onMain);
  }
  return out;
}

const kept = new Map(); // project id → {at, value (a promise)}
/** {KEY: 'main' | 'branch' | 'none'} of a project's tasks in Ready to ship and Review. A task of a project without git is left out. */
export function shippedOf(project, now = Date.now()) {
  const had = kept.get(project.id);
  if (had && now - had.at < KEEP_MS) return had.value;
  const value = look(project).catch(() => ({}));
  kept.set(project.id, { at: now, value });
  return value;
}
/** Tests: every look is a new one; `lines: false` keeps what side lines said (`keptLine`), as a later look of the board does. */
export function forgetShipped({ lines = true } = {}) { kept.clear(); repos.clear(); if (lines) linesKept.clear(); }

export const SHIP_AT_ONCE = 4; // projects looked at together: each look is a few git processes
/** {KEY: …} of several projects, as `shippedOf`, SHIP_AT_ONCE of them at a time. */
export async function shippedAll(projects, atOnce = SHIP_AT_ONCE) {
  const out = {};
  let next = 0;
  const worker = async () => { while (next < projects.length) Object.assign(out, await shippedOf(projects[next++])); };
  await Promise.all(Array.from({ length: Math.min(atOnce, projects.length) }, worker));
  return out;
}
