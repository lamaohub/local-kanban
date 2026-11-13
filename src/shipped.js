import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db, ghOwner, ghRepo } from './db.js';
import { repoHttpsBase } from './repo-base.js';
import { bin } from './bin-path.js';

const MAIN_SCAN = 3000;   // commits of main read: older ones are long shipped
const SIDE_SCAN = 1000;
const GIT_MS = 8000;
const SEP = '\x1e';
const KEY = /(?<![A-Za-z0-9])[A-Za-z0-9]+-\d+/g;
const NUMBER = /(?<![\w./-])(?:[\w.-]+\/[\w.-]+)?#\d+/g; // owner/repo#N or #N
const KEY_LIST = /^[^\p{L}\p{N}]*(?:and|\u0438)?[^\p{L}\p{N}]*$/iu; // what stands between two keys of one list

/** git's output, null when it failed. `unsure` (an object) gets `failed = true` when git did not answer at all — killed by
    GIT_MS, not started — rather than said no: such an answer is not kept (`keptLine`). */
let failing = null; // tests: the git calls (by their arguments) that answer as a git killed by GIT_MS does
/** Tests: git calls whose arguments match `re` fail as if git did not answer in time; null — none do. */
export const failGitFor = (re) => { failing = re; };
function git(path, args, env = {}, unsure = null) {
  if (failing?.test(args.join(' '))) { if (unsure) unsure.failed = true; return Promise.resolve(null); }
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
const cherryCopies = (out) => new Set(String(out || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => own(l.slice(2))));

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

/* What a look keeps of a repository is small and goes by a timer (the audit of 14.11.2026: the parsed logs held about
   2.5 MB a repository — every subject, and the whole output of `git log` its pieces were cut from — until the next look,
   and with a few dozen repositories a tab left on «All projects» held the board over pm2's limit). Kept: the words of main
   as one set, the side commits as {hash, tip, words}, every string copied out of git's output (`own`). A repository is
   read again only when its refs moved — one `git for-each-ref` tells that, the eight processes of a read do not run — and
   main's words only when main moved. A repository nobody asked about for REPO_IDLE_MS goes on a timer. */
export const KEEP_MS = 45_000;           // an answer of a project, and a check of a repository's refs: past the page's 30 s ask
export const REPO_IDLE_MS = 2 * 60_000; // a repository read nobody looked at again
const SWEEP_MS = 30_000;
const MAIN_REFS = ['origin/main', 'origin/master', 'main', 'master'];
// a string of its own: a piece cut out of a long one (a match, a split) keeps the whole of it alive in V8
const own = (s) => Buffer.from(String(s), 'utf8').toString('utf8');
const shortRef = (name) => name.replace(/^refs\/(heads|remotes)\//, '');

/** The refs of a `git for-each-ref --format='%(objectname) %(refname)'` as Map short name → hash. Pure. */
export function refsOf(out) {
  return new Map(String(out || '').split('\n').filter(Boolean).map((l) => {
    const at = l.indexOf(' ');
    return [own(shortRef(l.slice(at + 1))), own(l.slice(0, at))];
  }));
}

/** A read of a repository: {ref, mainAt, top, known, words (of main), side: [{hash, tip, words}], names, base, line(tip)};
    null — no main there. Throws when git did not answer: such a read is no answer (`repoOf` keeps the one before). `known` —
    the prefixes of the board (sorted, joined): a word is a key only with one of them, so they are a part of what was read.
    `prev` — the read before: main's words and tree are taken from it while main and the prefixes stand. */
async function readRepo(path, refs, store, prev, known) {
  const ref = MAIN_REFS.find((r) => refs.has(r));
  if (!ref) return null;
  const mainAt = refs.get(ref);
  const same = prev && prev.mainAt === mainAt && prev.known === known && Boolean(prev.top);
  const [mainLog, sideLog, tree, base] = await Promise.all([
    same ? '' : git(path, ['log', ref, '-n', String(MAIN_SCAN), `--format=${FORMAT}`]),
    git(path, ['log', '--source', '--no-merges', '--branches', '--remotes', '--not', ref, '-n', String(SIDE_SCAN), `--format=${FORMAT}`]),
    same ? prev.top : git(path, ['rev-parse', `${mainAt}^{tree}`]),
    repoHttpsBase(path),
  ]);
  // a tree git did not give is a failed read, not an empty one: kept, it hid every squash until main moved
  if (mainLog === null || sideLog === null || tree === null || !String(tree).trim()) throw new Error('git did not answer');
  const prefixes = new Set(known.split(' '));
  const top = own(String(tree).trim());
  const words = same ? prev.words : new Set(parseLog(mainLog, prefixes).flatMap((c) => [...c.words].map(own)));
  const side = parseLog(sideLog, prefixes).map((c) => ({ hash: own(c.hash), tip: own(c.tip), words: new Set([...c.words].map(own)) }));
  const names = [...refs.keys()].filter((n) => /^(origin\/)?claude\//.test(n));
  const lines = new Map();
  const line = (tip) => (refs.has(tip) ? keptLine(path, mainAt, refs.get(tip), top, store) : sideLine(path, ref, top, tip, store));
  return {
    ref, mainAt, top, known, words, side, names, base,
    line: (tip) => { if (!lines.has(tip)) lines.set(tip, line(tip)); return lines.get(tip); },
  };
}

const dirs = new Map();  // the folder of a project → {used, value: {id (the common git directory), store (its objects)} | null}
const repos = new Map(); // the common git directory → {used, checked, sig (of its refs), value (a promise of a read), checking}
/** The common git directory of a folder and the directory of its objects — one `git rev-parse` while it is asked about. */
async function dirOf(path, now) {
  const had = dirs.get(path);
  if (had) { had.used = now; return had.value; }
  const out = await git(path, ['rev-parse', '--git-common-dir', '--git-path', 'objects']);
  const [common, objects] = String(out || '').split('\n');
  const value = out === null || !common ? null : { id: own(resolve(path, common.trim())), store: objects ? own(resolve(path, objects.trim())) : null };
  if (value) dirs.set(path, { used: now, value }); // no git there: asked again next look, a folder may become a repository
  return value;
}
/** The repository of `path`, shared by every project in it (a folder of it, a worktree of it). */
async function repoOf(path, now = Date.now()) {
  const dir = await dirOf(path, now);
  if (!dir) return null;
  let e = repos.get(dir.id);
  if (!e) { e = { used: now, checked: -Infinity, sig: null, value: Promise.resolve(null), checking: null }; repos.set(dir.id, e); }
  e.used = now;
  sweepSoon();
  if (now - e.checked < KEEP_MS) return e.value;
  if (e.checking) return e.checking;
  const entry = e;
  entry.checking = (async () => {
    const out = await git(path, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']);
    // git did not answer: the last good read answers, and the next look asks again — a stalled git blanked every mark
    if (out === null) return entry.value;
    // the board's prefixes are a part of the read: a project added on this folder finds its keys at once, refs standing
    const known = db.prepare('SELECT DISTINCT upper(prefix) AS prefix FROM projects').all().map((p) => p.prefix).sort().join(' ');
    const sig = createHash('sha1').update(out).update('\0').update(known).digest('hex');
    if (sig !== entry.sig) {
      const prev = await entry.value.catch(() => null);
      const value = readRepo(path, refsOf(out), dir.store, prev, known).catch(() => {
        if (entry.value === value) entry.sig = null; // a failed read is not kept by the refs: asked again next look
        return prev; // and meanwhile the read before it answers
      });
      entry.value = value;
      entry.sig = sig;
    }
    entry.checked = Date.now();
    return entry.value;
  })().finally(() => { entry.checking = null; });
  return entry.checking;
}

async function look(project, tasks) {
  if (!tasks.length || !project.path) return {};
  const repo = await repoOf(project.path);
  if (!repo) return {}; // no git here, or no main: the card says nothing
  const { words: onMainWords, side: allSide, names, base } = repo;
  const mirror = mirrorName(ghOwner(), ghRepo());
  const home = Boolean(mirror) && base?.toLowerCase() === `https://github.com/${mirror}`.toLowerCase();
  const plans = tasks.map((t) => ({ key: t.key, words: wordsOf(t.key, t.issue, mirror, home), branches: branchesOf(t.key, names) }));
  // only the side commits and lines that hold a task of these columns: a repository may have hundreds of others
  const side = allSide.filter((c) => plans.some((t) => t.words.some((w) => c.words.has(w))));
  const main = [{ words: onMainWords }]; // what placeOf asks of main: does any of its commits carry a word of the task
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

const kept = new Map(); // project id → {at, sig (its tasks), value (a promise)}
/** {KEY: 'main' | 'branch' | 'none'} of a project's tasks in Ready to ship and Review. A task of a project without git is left
    out. An answer is kept KEEP_MS while the tasks of the columns stay the same: a task come into Review is looked at now. */
export function shippedOf(project, now = Date.now()) {
  const tasks = db.prepare(`SELECT p.prefix || '-' || t.task_no AS key, t.gh_issue_number AS issue, t.labels FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN ('ready', 'review') ORDER BY t.id`).all(project.id)
    .filter((t) => !/"(noclaude|check)"/.test(t.labels || '')).map(({ key, issue }) => ({ key, issue }));
  const sig = `${project.path || ''} ${JSON.stringify(tasks)}`;
  const had = kept.get(project.id);
  if (had && had.sig === sig && now - had.at < KEEP_MS) return had.value;
  const value = look(project, tasks).catch(() => ({}));
  kept.set(project.id, { at: now, sig, value });
  sweepSoon();
  return value;
}

let sweeper = null;
/** Drop what nobody asked about: answers past KEEP_MS, repositories and folders past REPO_IDLE_MS. Returns what is left. */
export function sweepShipped(now = Date.now()) {
  for (const [k, v] of kept) if (now - v.at >= KEEP_MS) kept.delete(k);
  for (const [k, v] of repos) if (now - v.used >= REPO_IDLE_MS && !v.checking) repos.delete(k);
  for (const [k, v] of dirs) if (now - v.used >= REPO_IDLE_MS) dirs.delete(k);
  for (const [k, v] of linesKept) if (now - v.used >= LINE_IDLE_MS) linesKept.delete(k);
  if (!kept.size && !repos.size && !dirs.size && !linesKept.size && sweeper) { clearInterval(sweeper); sweeper = null; }
  return { answers: kept.size, repos: repos.size, folders: dirs.size, lines: linesKept.size };
}
function sweepSoon() {
  if (sweeper) return;
  sweeper = setInterval(() => sweepShipped(), SWEEP_MS);
  sweeper.unref?.();
}
/** Tests: what a look keeps of the repositories read (their values, settled). */
export const keptRepos = async () => Promise.all([...repos.values()].map((e) => e.value));
/** Tests: every look is a new one; `lines: false` keeps what side lines said (`keptLine`), as a later look of the board does;
    `repos: false` keeps the repositories read too (a look past KEEP_MS checks their refs). */
export function forgetShipped({ lines = true, repos: keepRepos = true } = {}) {
  kept.clear();
  if (keepRepos) { repos.clear(); dirs.clear(); } else for (const e of repos.values()) e.checked = -Infinity;
  if (lines) linesKept.clear();
}

export const SHIP_AT_ONCE = 4; // projects looked at together: each look is a few git processes
/** {KEY: …} of several projects, as `shippedOf`, SHIP_AT_ONCE of them at a time. */
export async function shippedAll(projects, atOnce = SHIP_AT_ONCE) {
  const out = {};
  let next = 0;
  const worker = async () => { while (next < projects.length) Object.assign(out, await shippedOf(projects[next++])); };
  await Promise.all(Array.from({ length: Math.min(atOnce, projects.length) }, worker));
  return out;
}
