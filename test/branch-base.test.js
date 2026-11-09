// branches from the main checkout's HEAD — dev — and its «Changes», «ahead», conflict and pull request are measured
// against dev, not main (they took dev's commits for the task's). An old copy, made before the base was written down,
// keeps the old way. The files in conflict are named as they are — a space and Cyrillic in a name included.
// A real git with a bare origin; gh is a stand-in (KB_GH_BIN).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
let app, tmp, db, repo, origin, ghLog, W;
const CYR = '\u0444\u0430\u0439\u043b'; // a Cyrillic word, written so that the source stays Latin (the release audit)
const ODD = join('dir x', `${CYR}.txt`);

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-dev-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), KB_LAUNCH_DRYRUN: '', ...ENV });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  origin = join(tmp, 'origin.git');
  execFileSync(fullPath('git'), ['init', '-q', '--bare', '-b', 'main', origin], { env: { ...process.env, ...ENV } });
  repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'dir x'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, ODD), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'dev');
  writeFileSync(join(repo, 'dev.txt'), 'dev\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'dev only: not the task\'s');
  git(repo, 'push', '-q', '-u', 'origin', 'dev');
  ghLog = join(tmp, 'gh.log');
  const gh = join(tmp, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\ncase "$1 $2" in\n  "pr create") echo "https://github.com/me/repo/pull/9";;\n  "pr view") echo '{"number":9,"url":"https://github.com/me/repo/pull/9","state":"OPEN"}';;\nesac\n`);
  chmodSync(gh, 0o755);
  process.env.KB_GH_BIN = gh;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no, worktrees) VALUES ('dv', 'DV', 'Dev', ?, 3, 1)").run(repo);
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES ((SELECT id FROM projects WHERE slug = 'dv'), ?, ?, '', 'doing')");
  add.run(1, 'On dev'); add.run(2, 'An old copy');
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const task = (no) => db.prepare("SELECT t.*, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'dv' AND t.task_no = ?").get(no);
const proj = () => db.prepare("SELECT * FROM projects WHERE slug = 'dv'").get();

test('a copy made from dev is measured against dev: its own commit only — in «Changes», «ahead» and the request', async () => {
  const copy = (await W.taskFolder(proj(), [task(1)])).path;
  assert.equal(W.worktreeOf(task(1).id).base, 'dev', 'the branch the copy was made from is not written down');
  writeFileSync(join(copy, 'a.txt'), 'mine\n');
  git(copy, 'commit', '-q', '-am', 'DV-1 mine');
  const b = (await app.inject('/api/tasks/DV-1/branch')).json();
  assert.deepEqual([b.base, b.ahead, b.conflict], ['dev', 1, { files: [] }], 'dev\'s commit counted as the task\'s');
  const ch = (await app.inject('/api/tasks/DV-1/changes')).json();
  assert.equal(ch.base, 'dev');
  assert.deepEqual(ch.commits.map((c) => c.subject), ['DV-1 mine'], 'a commit of dev shown as the task\'s change');
  const pr = await app.inject({ method: 'POST', url: '/api/tasks/DV-1/pr', payload: {} });
  assert.equal(pr.statusCode, 200, pr.body);
  assert.match(readFileSync(ghLog, 'utf8'), /^pr create --base dev --head claude\/DV-1 /m, 'the request asks to merge into main');
});

test('an attempt made from dev is measured against dev too, and «Take this one» keeps its base', async () => {
  const made = await app.inject({ method: 'POST', url: '/api/tasks/DV-1/attempts', payload: { profile: null } });
  assert.equal(made.statusCode, 201, made.body);
  const list = (await app.inject('/api/tasks/DV-1/attempts')).json().attempts;
  assert.deepEqual(list.map((a) => [a.n, a.base, a.ahead]), [[1, 'dev', 1], [2, 'dev', 0]]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/DV-1/attempts/2/take', payload: {} })).statusCode, 200);
  assert.equal(W.worktreeOf(task(1).id).base, 'dev');
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/DV-1/attempts/1/take', payload: {} })).statusCode, 200);
});

test('a copy with no base written down (made before) is measured as before — against origin\'s HEAD', async () => {
  await W.taskFolder(proj(), [task(2)]);
  db.prepare('UPDATE task_worktrees SET base = NULL WHERE task_id = ?').run(task(2).id);
  const b = (await app.inject('/api/tasks/DV-2/branch')).json();
  assert.deepEqual([b.base, b.ahead], ['main', 1]);
});

test('a conflict names its files as they are: a space and Cyrillic in the name, not git\'s C-quoting', async () => {
  const copy = W.worktreeOf(task(1).id).path;
  writeFileSync(join(copy, ODD), 'the task\'s\n');
  git(copy, 'commit', '-q', '-am', 'DV-1 odd name');
  writeFileSync(join(repo, ODD), 'dev\'s\n');
  writeFileSync(join(repo, 'a.txt'), 'dev\'s line\n');
  git(repo, 'commit', '-q', '-am', 'dev changes the same lines');
  git(repo, 'push', '-q', 'origin', 'dev');
  const b = (await app.inject('/api/tasks/DV-1/branch')).json();
  assert.deepEqual(b.conflict, { files: ['a.txt', `dir x/${CYR}.txt`] });
  const { conflictFiles } = await import('../src/task-branch.js');
  assert.deepEqual(conflictFiles('tree\0a b.txt\0a b.txt\0x\n"y\0\0message 1\0'), ['a b.txt', 'x\n"y']);
});
