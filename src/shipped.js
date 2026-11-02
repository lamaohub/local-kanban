import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db, ghOwner, ghRepo } from './db.js';
import { repoHttpsBase } from './repo-base.js';

const KEEP_MS = 30_000;
const MAIN_SCAN = 3000;   // commits of main read: older ones are long shipped
const SIDE_SCAN = 1000;
const GIT_MS = 8000;
const SEP = '\x1e';
const KEY = /(?<![A-Za-z0-9])[A-Za-z0-9]+-\d+/g;
const NUMBER = /(?<![\w./-])(?:[\w.-]+\/[\w.-]+)?#\d+/g; // owner/repo#N or #N
const KEY_LIST = /^[^\p{L}\p{N}]*(?:and|\u0438)?[^\p{L}\p{N}]*$/iu; // what stands between two keys of one list

function git(path, args, env = {}) {
  return new Promise((done) => {
    execFile('git', ['-C', path, ...args], { timeout: GIT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, out) => done(err ? null : out));
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
const alternate = (p) => (/[:"\\]/.test(p) ? `"${p.replace(/["\\]/g, '\\$&')}"` : p);

/** Whether a line ahead by patches is squashed into main: merging it leaves main's tree as it is, and it does change something
    (a line that took its work back merges the same way, with nothing on main). Git before 2.38 has no `--write-tree`, and a
    conflict is not proof: neither is squashed. `--write-tree` puts the trees it makes into the objects of the repository, and
    a look at a card must not grow the person's repository: `shelf` sends them to a directory of the look, reading through to
    the real objects. */
async function squashed(path, ref, tree, tip, shelf) {
  if (!shelf) return false;
  const merged = await git(path, ['merge-tree', '--write-tree', ref, tip], shelf);
  if (merged === null || merged.split('\n')[0].trim() !== tree) return false;
  return Boolean((await git(path, ['diff', '--name-only', `${ref}...${tip}`]))?.trim());
}

/** A side line against main: {state (as `cherryState`), copies (hashes of its commits with their patch on main)}. */
async function sideLine(path, ref, tree, tip, shelf) {
  const out = await git(path, ['cherry', ref, tip]);
  const state = cherryState(out);
  return { state: state === 'ahead' && await squashed(path, ref, tree, tip, shelf) ? 'in' : state, copies: cherryCopies(out) };
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

async function look(project) {
  const tasks = db.prepare(`SELECT t.id, p.prefix || '-' || t.task_no AS key, t.gh_issue_number AS issue, t.labels FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN ('ready', 'review')`).all(project.id)
    .filter((t) => !/"(noclaude|check)"/.test(t.labels || ''));
  if (!tasks.length || !project.path) return {};
  const ref = await mainRef(project.path);
  if (!ref) return {}; // no git here, or no main: the card says nothing
  const [mainLog, sideLog, refs, tree, objects, base] = await Promise.all([
    git(project.path, ['log', ref, '-n', String(MAIN_SCAN), `--format=${FORMAT}`]),
    git(project.path, ['log', '--source', '--no-merges', '--branches', '--remotes', '--not', ref, '-n', String(SIDE_SCAN), `--format=${FORMAT}`]),
    git(project.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/claude', 'refs/remotes/origin/claude']),
    git(project.path, ['rev-parse', `${ref}^{tree}`]),
    git(project.path, ['rev-parse', '--git-path', 'objects']),
    repoHttpsBase(project.path),
  ]);
  if (mainLog === null || sideLog === null) return {};
  const known = new Set(db.prepare('SELECT upper(prefix) AS prefix FROM projects').all().map((p) => p.prefix));
  const main = parseLog(mainLog, known);
  const side = parseLog(sideLog, known);
  const names = String(refs || '').split('\n').filter(Boolean);
  const mirror = mirrorName(ghOwner(), ghRepo());
  const home = Boolean(mirror) && base?.toLowerCase() === `https://github.com/${mirror}`.toLowerCase();
  const plans = tasks.map((t) => ({ key: t.key, words: wordsOf(t.key, t.issue, mirror, home), branches: branchesOf(t.key, names) }));
  // only the lines that hold a task of these columns: a repository may have hundreds of others
  const tips = new Set(plans.flatMap((t) => [...t.branches, ...side.filter((c) => t.words.some((w) => c.words.has(w))).map((c) => c.tip)]));
  const lines = new Map();
  const scratch = tips.size ? await mkdtemp(join(tmpdir(), 'kb-ship-')).catch(() => null) : null; // none: a squash is not seen, the rest stands
  const shelf = scratch && objects !== null ? { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(resolve(project.path, objects.trim())) } : null;
  try {
    for (const tip of tips) lines.set(tip, await sideLine(project.path, ref, String(tree || '').trim(), tip, shelf)); // one by one: this is a hint, not worth the cores
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
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
/** Tests: every look is a new one. */
export function forgetShipped() { kept.clear(); }
