import { execFile } from 'node:child_process';
import { db } from './db.js';

const KEEP_MS = 30_000;
const MAIN_SCAN = 3000;   // commits of main read: older ones are long shipped
const SIDE_SCAN = 1000;
const GIT_MS = 8000;
const SEP = '\x1e';
const WORDS = /[A-Za-z][A-Za-z0-9]*-\d+|#\d+/g;

function git(path, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', path, ...args], { timeout: GIT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, out) => resolve(err ? null : out));
  });
}

/** Commits of a `git log` with FORMAT: [{hash, subject, words}] — `words` the keys and issue numbers of the message. Pure. */
const FORMAT = `%H%n%s%n%B${SEP}`;
export function parseLog(out) {
  return String(out || '').split(SEP).map((c) => c.replace(/^\n/, '')).filter(Boolean).map((c) => {
    const [hash, subject = ''] = c.split('\n', 2);
    return { hash, subject, words: new Set((c.slice(hash.length).match(WORDS) || []).map((w) => w.toUpperCase())) };
  });
}

/** Where task `t` {key, issue, hashes, branch} stands. `branch`: 'ahead' — its own branch holds what main has not, 'in' — all it
    holds is on main, null — no such branch, or one with no commits of its own. `copies` — hashes of the side commits whose
    patch stands on main. Pure. */
export function placeOf(t, main, side, copies) {
  const mine = (c) => c.words.has(t.key.toUpperCase()) || (t.issue && c.words.has(`#${t.issue}`)) || t.hashes.some((h) => c.hash.startsWith(h));
  if (t.branch === 'ahead' || side.some((c) => mine(c) && !copies.has(c.hash))) return 'branch';
  return t.branch === 'in' || main.some(mine) || side.some(mine) ? 'main' : 'none';
}

export function branchesOf(key, names) {
  const k = new RegExp(`(^|[-/_])${key}($|[-/_])`, 'i');
  return names.filter((n) => k.test(n.replace(/^(origin\/)?claude\//, '')));
}

const patchId = (path, hash) => new Promise((resolve) => {
  const show = execFile('git', ['-C', path, 'show', '--format=', hash], { timeout: GIT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
    if (err) { resolve(null); return; }
    const id = execFile('git', ['-C', path, 'patch-id', '--stable'], { timeout: GIT_MS }, (e, o) => resolve(e ? null : String(o).split(' ')[0] || null));
    id.stdin.on('error', () => {});
    id.stdin.end(out);
  });
  show.on('error', () => resolve(null));
});

/** Of the side commits sharing a subject with main, those whose patch stands on main. */
async function copiesOn(path, main, side) {
  const bySubject = new Map();
  for (const c of main) if (!bySubject.has(c.subject)) bySubject.set(c.subject, c);
  const out = new Set();
  for (const c of side) {
    const twin = bySubject.get(c.subject);
    if (!twin) continue;
    const [a, b] = await Promise.all([patchId(path, c.hash), patchId(path, twin.hash)]);
    if (a && a === b) out.add(c.hash);
  }
  return out;
}

/** What `git cherry` says of a branch against main: 'ahead', 'in', or null when it has no commit of its own. Pure. */
export function cherryState(out) {
  const lines = String(out || '').split('\n').filter(Boolean);
  if (!lines.length) return null;
  return lines.some((l) => l.startsWith('+')) ? 'ahead' : 'in';
}

async function mainRef(path) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) !== null) return ref;
  }
  return null;
}

async function look(project) {
  const tasks = db.prepare(`SELECT t.id, p.prefix || '-' || t.task_no AS key, t.gh_issue_number AS issue, t.labels FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN ('ready', 'review')`).all(project.id)
    .filter((t) => !/"(noclaude|check)"/.test(t.labels || ''));
  if (!tasks.length || !project.path) return {};
  const ref = await mainRef(project.path);
  if (!ref) return {}; // no git here, or no main: the card says nothing
  const [mainLog, sideLog, refs] = await Promise.all([
    git(project.path, ['log', ref, '-n', String(MAIN_SCAN), `--format=${FORMAT}`]),
    git(project.path, ['log', '--branches', '--remotes', '--not', ref, '-n', String(SIDE_SCAN), `--format=${FORMAT}`]),
    git(project.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/claude', 'refs/remotes/origin/claude']),
  ]);
  if (mainLog === null || sideLog === null) return {};
  const main = parseLog(mainLog);
  const side = parseLog(sideLog);
  const copies = await copiesOn(project.path, main, side);
  const branches = String(refs || '').split('\n').filter(Boolean);
  const out = {};
  for (const t of tasks) {
    const hashes = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'git'").all(t.id)
      .map((c) => c.body.split(/\s/)[0]).filter((h) => /^[0-9a-f]{7,40}$/.test(h));
    const states = await Promise.all(branchesOf(t.key, branches).map(async (b) => cherryState(await git(project.path, ['cherry', ref, b]))));
    const branch = states.includes('ahead') ? 'ahead' : states.includes('in') ? 'in' : null;
    out[t.key] = placeOf({ key: t.key, issue: t.issue, hashes, branch }, main, side, copies);
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
