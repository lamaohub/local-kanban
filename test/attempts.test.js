// beside the task's other Claude; «Take this one» makes its copy the task's. A real git, ▶ as a dry run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
let tmp, db, app, repo, W;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-att-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), KB_LAUNCH_DRYRUN: '1', ...ENV });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.js'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  mkdirSync(join(tmp, 'plain'));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, worktrees) VALUES ('at', 'AT', 'Attempts', ?, 1)").run(repo);
  db.prepare("INSERT INTO projects (slug, prefix, name, path) VALUES ('pl', 'PL', 'Plain', ?)").run(join(tmp, 'plain'));
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'at'), 1, 'try it', 'doing')").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'pl'), 1, 'plain', 'todo')").run();
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.register((await import('../src/routes/profiles.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const task = () => db.prepare("SELECT t.*, 'AT-1' AS key FROM tasks t WHERE title = 'try it'").get();

test('a second attempt: a copy of its own on its own branch, the first copy kept as attempt 1', async () => {
  const first = await W.taskFolder(db.prepare("SELECT * FROM projects WHERE slug = 'at'").get(), [task()]);
  writeFileSync(join(first.path, 'a.js'), 'one\nfirst way\n');
  git(first.path, 'commit', '-q', '-am', 'AT-1 first way');
  const prof = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Haiku', model: 'claude-haiku-5-5' } })).json();
  const r = await app.inject({ method: 'POST', url: '/api/tasks/AT-1/attempts', payload: { profile: prof.id } });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual([r.json().n, r.json().branch], [2, 'claude/AT-1-a2']);
  assert.equal(r.json().path, join(repo, '.claude', 'worktrees', 'AT-1-a2'));
  assert.equal(git(r.json().path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/AT-1-a2');
  const list = (await app.inject('/api/tasks/AT-1/attempts')).json().attempts;
  assert.deepEqual(list.map((a) => [a.n, a.branch, a.chosen, a.ahead, a.profile]), [[1, 'claude/AT-1', true, 1, null], [2, 'claude/AT-1-a2', false, 0, 'Haiku']]);
});

test('its Claude starts in its copy, on its profile, beside the task\'s own — and moves nothing', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'at', keys: ['AT-1'], attempt: 2, text: 'Attempt 2' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().folder, join(repo, '.claude', 'worktrees', 'AT-1-a2'));
  assert.match(r.json().args.join(' '), /--model claude-haiku-5-5/);
  assert.equal(task().status, 'doing');
  assert.equal((await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'at', keys: ['AT-1'], attempt: 7, text: 'x' } })).statusCode, 404);
});

test('«Changes» of an attempt, then «Take this one»: its copy is the task\'s, the first one stays an attempt', async () => {
  const a2 = join(repo, '.claude', 'worktrees', 'AT-1-a2');
  writeFileSync(join(a2, 'a.js'), 'one\nsecond way\n');
  git(a2, 'commit', '-q', '-am', 'AT-1 second way');
  const ch = (await app.inject('/api/tasks/AT-1/changes?attempt=2')).json();
  assert.deepEqual(ch.commits.map((c) => c.subject), ['AT-1 second way']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/AT-1/attempts/2/take', payload: {} })).statusCode, 200);
  assert.deepEqual((await app.inject('/api/tasks/AT-1')).json().worktree, { path: a2, branch: 'claude/AT-1-a2' });
  const list = (await app.inject('/api/tasks/AT-1/attempts')).json().attempts;
  assert.deepEqual(list.map((a) => [a.n, a.chosen]), [[1, false], [2, true]]);
  assert.deepEqual((await app.inject('/api/tasks/AT-1/changes')).json().commits.map((c) => c.subject), ['AT-1 second way'], '«Changes» of the card follow the taken attempt');
});

test('attempts need copies; at most five; a guest neither makes nor takes one', async () => {
  const plain = await app.inject({ method: 'POST', url: '/api/tasks/PL-1/attempts', payload: {} });
  assert.equal(plain.statusCode, 409);
  assert.equal(plain.json().reason, 'no-copies');
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/AT-1/attempts', payload: {} })).statusCode, 201);
  const sixth = await app.inject({ method: 'POST', url: '/api/tasks/AT-1/attempts', payload: {} });
  assert.equal(sixth.json().reason, 'too-many');
  assert.ok(existsSync(join(repo, '.claude', 'worktrees', 'AT-1-a5')));
  const { ownerOnly } = await import('../src/share.js');
  assert.equal(ownerOnly('POST', '/api/tasks/:id/attempts'), true);
  assert.equal(ownerOnly('POST', '/api/tasks/:id/attempts/:n/take'), true);
});
