// look at the card, a request merged or closed gives way to a new one when the branch has new commits, the board's list
// and its cards know the request (task_prs, no ask of GitHub) and hear when it changes, and a refusal of git or gh says
// its own line — never the command line with the card's description.
// A real git with a bare origin; gh is a stand-in (KB_GH_BIN) answering from a JSON file the test writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
let app, tmp, db, repo, origin, ghLog, ghState, W, bus;

// what the stand-in gh answers: `view` — by the address or the branch asked, `create` — the address `pr create` prints,
// `mode` — 'fail' (exit 1, nothing said), 'slow-fail' (the same after 400 ms)
const setGh = (s) => writeFileSync(ghState, JSON.stringify(s));
const asked = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-prs-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), ...ENV });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  origin = join(tmp, 'origin.git');
  execFileSync(fullPath('git'), ['init', '-q', '--bare', '-b', 'main', origin], { env: { ...process.env, ...ENV } });
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  ghLog = join(tmp, 'gh.log');
  ghState = join(tmp, 'gh.json');
  const gh = join(tmp, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, a.join(' ') + '\\n');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, 'utf8'));
const end = (code) => setTimeout(() => process.exit(code), s.mode === 'slow-fail' ? 400 : 0);
if (s.mode === 'fail' || s.mode === 'slow-fail') end(1);
else if (a[0] === 'pr' && a[1] === 'create') { if (s.createFail) process.exit(1); console.log(s.create); }
else if (a[0] === 'pr' && a[1] === 'view') { const v = s.view[a[2]]; if (!v) process.exit(1); console.log(JSON.stringify(v)); }
`);
  chmodSync(gh, 0o755);
  process.env.KB_GH_BIN = gh;
  setGh({ view: {} });
  ({ db } = await import('../src/db.js'));
  ({ bus } = await import('../src/bus.js'));
  const { ghState: sync } = await import('../src/sync/worker.js');
  sync.available = false; sync.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no, worktrees) VALUES ('pq', 'PQ', 'Requests', ?, 4, 1)").run(repo);
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES ((SELECT id FROM projects WHERE slug = 'pq'), ?, ?, ?, 'review')");
  add.run(1, 'Merged once', 'first'); add.run(2, 'Asked of a broken gh', 'second'); add.run(3, 'Refused', 'SECRET-DESCRIPTION of the card');
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const task = (no) => db.prepare("SELECT t.*, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'pq' AND t.task_no = ?").get(no);
const proj = () => db.prepare("SELECT * FROM projects WHERE slug = 'pq'").get();
const commitIn = (dir, name, words) => { writeFileSync(join(dir, name), `${words}\n`); git(dir, 'add', name); git(dir, 'commit', '-q', '-m', words); };
const old = (no) => db.prepare("UPDATE task_prs SET checked_at = datetime('now', '-1 hour') WHERE task_id = ?").run(task(no).id);
const listed = async (key) => (await app.inject('/api/tasks?project=pq&all=1')).json().find((t) => t.key === key);

test('a gh that fails is asked once a PR_FRESH_MS — one ask at a time — not on every look at the card', async () => {
  const copy = (await W.taskFolder(proj(), [task(2)])).path;
  commitIn(copy, 'b.txt', 'PQ-2 b');
  db.prepare("INSERT INTO task_prs (task_id, url, number, state) VALUES (?, 'https://github.com/me/repo/pull/3', 3, 'OPEN')").run(task(2).id);
  old(2);
  setGh({ mode: 'slow-fail', view: {} });
  const before = asked().length;
  const looks = await Promise.all([1, 2, 3].map(() => app.inject('/api/tasks/PQ-2/branch')));
  assert.deepEqual(looks.map((r) => r.json().pr?.state), ['OPEN', 'OPEN', 'OPEN'], 'the last known request is not shown while gh fails');
  assert.equal((await app.inject('/api/tasks/PQ-2/branch')).json().pr.number, 3);
  assert.equal(asked().length - before, 1, `gh was asked on every look: ${asked().slice(before).join(' | ')}`);
});

test('the list of tasks and its events carry the request as last known — and hear when GitHub says it changed', async () => {
  const copy = (await W.taskFolder(proj(), [task(1)])).path;
  commitIn(copy, 'c.txt', 'PQ-1 c');
  const head = git(copy, 'rev-parse', 'HEAD');
  setGh({ create: 'https://github.com/me/repo/pull/7', view: { 'https://github.com/me/repo/pull/7': { number: 7, url: 'https://github.com/me/repo/pull/7', state: 'OPEN', headRefOid: head } } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/PQ-1/pr', payload: {} })).statusCode, 200);
  assert.deepEqual((await listed('PQ-1')).pr, { number: 7, state: 'OPEN', url: 'https://github.com/me/repo/pull/7' }, 'the list does not carry the request');
  assert.equal((await listed('PQ-3')).pr, null);
  const seen = [];
  const hear = (ev) => { if (ev.type === 'task.updated') seen.push(ev.data); };
  bus.on('event', hear);
  try {
    // merged on GitHub: the next look at the card past PR_FRESH_MS learns it, and the list kept until an event shows it
    setGh({ view: { 'https://github.com/me/repo/pull/7': { number: 7, url: 'https://github.com/me/repo/pull/7', state: 'MERGED', headRefOid: head } } });
    old(1);
    const before = asked().length;
    assert.equal((await app.inject('/api/tasks/PQ-1/branch')).json().pr.state, 'MERGED');
    assert.equal(asked().length - before, 1);
    assert.equal((await listed('PQ-1')).pr.state, 'MERGED', 'the list kept from before still says open');
    assert.equal(seen.filter((t) => t.key === 'PQ-1').at(-1)?.pr?.state, 'MERGED', 'no task.updated with the new state for the cards');
    // the same state asked again is no event: the kept list is not thrown away every minute
    old(1);
    const n = seen.length;
    await app.inject('/api/tasks/PQ-1/branch');
    assert.equal(seen.length, n);
  } finally { bus.off('event', hear); }
});

test('a request merged: a new commit in the branch — a new request, not the merged one taken for it', async () => {
  const copy = W.worktreeOf(task(1).id).path;
  assert.equal((await app.inject('/api/tasks/PQ-1/branch')).json().ahead_of_pr, 0, 'the merged head is not the branch\'s');
  commitIn(copy, 'd.txt', 'PQ-1 more');
  const b = (await app.inject('/api/tasks/PQ-1/branch')).json();
  assert.deepEqual([b.pr.state, b.ahead, b.ahead_of_pr], ['MERGED', 2, 1]);
  const { prButtonShown } = await import('../public/js/branch-rules.js');
  assert.equal(prButtonShown(b), true, '«Open a pull request» is not back after the merge');
  // gh by the branch answers the merged one (it finds the requests of the branch); by the new address — the new one
  const head = git(copy, 'rev-parse', 'HEAD');
  setGh({ create: 'https://github.com/me/repo/pull/8', view: {
    'claude/PQ-1': { number: 7, url: 'https://github.com/me/repo/pull/7', state: 'MERGED' },
    'https://github.com/me/repo/pull/8': { number: 8, url: 'https://github.com/me/repo/pull/8', state: 'OPEN', headRefOid: head } } });
  const r = await app.inject({ method: 'POST', url: '/api/tasks/PQ-1/pr', payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { url: 'https://github.com/me/repo/pull/8', number: 8, state: 'OPEN' });
  assert.equal((await listed('PQ-1')).pr.number, 8);
  assert.equal(prButtonShown((await app.inject('/api/tasks/PQ-1/branch')).json()), false, 'a second button next to the open request');
  // gh printed no address and knows only the merged one by the branch: refused, not the merged one written down as new
  commitIn(copy, 'e.txt', 'PQ-1 again');
  db.prepare("UPDATE task_prs SET state = 'CLOSED' WHERE task_id = ?").run(task(1).id);
  setGh({ create: '', view: { 'claude/PQ-1': { number: 7, url: 'https://github.com/me/repo/pull/7', state: 'MERGED' } } });
  const lost = await app.inject({ method: 'POST', url: '/api/tasks/PQ-1/pr', payload: {} });
  assert.equal(lost.json().reason, 'gh', lost.body);
  assert.equal(db.prepare('SELECT number FROM task_prs WHERE task_id = ?').get(task(1).id).number, 8);
});

test('a refusal says git\'s fatal line and gh\'s own words — never the command line with the description', async () => {
  const copy = (await W.taskFolder(proj(), [task(3)])).path;
  commitIn(copy, 'f.txt', 'PQ-3 f');
  git(copy, 'remote', 'set-url', 'origin', join(tmp, 'nowhere.git'));
  try {
    const push = (await app.inject({ method: 'POST', url: '/api/tasks/PQ-3/pr', payload: {} })).json();
    assert.equal(push.reason, 'push');
    assert.match(push.error, /does not appear to be a git repository/, `the last line of git's advice: ${push.error}`);
  } finally { git(copy, 'remote', 'set-url', 'origin', origin); }
  setGh({ createFail: true, view: {} });
  const gh = (await app.inject({ method: 'POST', url: '/api/tasks/PQ-3/pr', payload: {} })).json();
  assert.equal(gh.reason, 'gh');
  assert.doesNotMatch(gh.error, /SECRET-DESCRIPTION|--body|Command failed/, gh.error);
  const { failLine } = await import('../src/task-branch.js');
  assert.equal(failLine({ err: { killed: true, signal: 'SIGTERM', message: 'Command failed: gh pr create --body SECRET' }, text: '' }, 'gh'), 'gh did not answer in time');
  assert.equal(failLine({ err: { code: 128 }, text: "fatal: 'x' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists." }, 'git'),
    "fatal: 'x' does not appear to be a git repository");
});
