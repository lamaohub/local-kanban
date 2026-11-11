// at <top>/.claude/worktrees/<KEY> on the branch claude/<KEY>, brings the files outside git the project names, and
// starts Claude there; «Continue» starts the session in the same copy; kb show names it, kb info says how it ships.
// A real git, the real routes on a socket, ▶ as a dry run (KB_LAUNCH_DRYRUN: nothing is started).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const SID = '11111111-2222-4333-8444-555555555555';
let app, tmp, db, base, repo, mono;
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
function makeRepo(dir, sub = '') {
  mkdirSync(join(dir, sub), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), '.env\nnode_modules/\n');
  writeFileSync(join(dir, sub, 'app.js'), 'ok');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
}

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-wt-')));
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_CLAUDE_DIR = join(tmp, 'claude');
  mkdirSync(process.env.KB_CLAUDE_DIR);
  repo = join(tmp, 'repo');
  makeRepo(repo);
  writeFileSync(join(repo, '.env'), 'SECRET=1');
  mkdirSync(join(repo, 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'lib', 'index.js'), '');
  mono = join(tmp, 'mono');
  makeRepo(mono, 'apps/web');
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no, worktrees, worktree_files, worktree_setup) VALUES ('wt', 'WT', 'Copies', ?, 3, 1, 'copy .env\nlink node_modules\ncopy missing.txt', 'npm install')").run(repo);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no, worktrees) VALUES ('web', 'WB', 'Web of a monorepo', ?, 2, 1)").run(join(mono, 'apps/web'));
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('plain', 'PL', 'No copies', ?, 2)").run(join(tmp, 'plain'));
  mkdirSync(join(tmp, 'plain'));
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = ?), ?, ?, 'todo')");
  add.run('wt', 1, 'one'); add.run('wt', 2, 'two'); add.run('web', 1, 'web one'); add.run('plain', 1, 'plain one');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const launch = async (body) => (await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', text: 'Do it', ...body } }));
const kb = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

const proj = (slug) => db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
const taskOf = (slug, no) => db.prepare("SELECT t.*, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ? AND t.task_no = ?").get(slug, no);
let W;

test('a dry run of ▶ names the copy and makes nothing', async () => {
  W = await import('../src/worktrees.js');
  const r = await launch({ project: 'wt', keys: ['WT-1'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().folder, join(repo, '.claude', 'worktrees', 'WT-1'));
  assert.equal(r.json().branch, 'claude/WT-1');
  assert.ok(!existsSync(join(repo, '.claude')), 'a dry run made a copy');
  assert.doesNotMatch(git(repo, 'branch', '--list'), /claude\//);
});

test('the copy of the task on its own branch, with the files outside git; ▶ then starts there', async () => {
  const made = await W.taskFolder(proj('wt'), [taskOf('wt', 1)]);
  const copy = join(repo, '.claude', 'worktrees', 'WT-1');
  assert.deepEqual([made.path, made.branch, made.created], [copy, 'claude/WT-1', true]);
  assert.ok(git(repo, 'worktree', 'list').includes(copy), 'no git worktree');
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/WT-1');
  assert.equal(readFileSync(join(copy, '.env'), 'utf8'), 'SECRET=1', 'the copied .env');
  assert.ok(lstatSync(join(copy, 'node_modules')).isSymbolicLink(), 'node_modules is a link');
  assert.ok(!existsSync(join(copy, 'missing.txt')), 'a file the project does not have is skipped');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the copies show in the main checkout\'s git status');
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/worktrees\/$/m);
  // `git add -A` in it commits a link to the main checkout and «Stands» never sees the copy free
  assert.equal(git(copy, 'status', '--porcelain'), '', 'the link of node_modules shows in the copy\'s git status');
  // … and a file the main checkout shows (untracked, not ignored) keeps showing there: info/exclude is shared
  writeFileSync(join(repo, 'local.cfg'), 'mine');
  db.prepare("UPDATE projects SET worktree_files = worktree_files || '\nlink local.cfg' WHERE slug = 'wt'").run();
  await W.taskFolder(proj('wt'), [taskOf('wt', 1)]);
  assert.ok(lstatSync(join(copy, 'local.cfg')).isSymbolicLink());
  assert.equal(git(repo, 'status', '--porcelain'), '?? local.cfg', 'a link of the copies hid the owner\'s own file from git status');
  assert.doesNotMatch(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /local\.cfg/);
  rmSync(join(repo, 'local.cfg'));
  rmSync(join(copy, 'local.cfg'));
  db.prepare("UPDATE projects SET worktree_files = 'copy .env\nlink node_modules\ncopy missing.txt' WHERE slug = 'wt'").run();
  assert.deepEqual((await app.inject('/api/tasks/WT-1')).json().worktree, { path: copy, branch: 'claude/WT-1', base: 'main' });
  assert.equal((await launch({ project: 'wt', keys: ['WT-1'] })).json().folder, copy);
});

test('a second start takes the same copy and keeps what changed in it; a task with a copy of its own keeps it in a batch', async () => {
  const copy = join(repo, '.claude', 'worktrees', 'WT-1');
  writeFileSync(join(copy, 'work.txt'), 'in progress');
  writeFileSync(join(copy, '.env'), 'CHANGED');
  const again = await W.taskFolder(proj('wt'), [taskOf('wt', 1)]);
  assert.deepEqual([again.path, again.created], [copy, false]);
  assert.equal(readFileSync(join(copy, 'work.txt'), 'utf8'), 'in progress');
  assert.equal(readFileSync(join(copy, '.env'), 'utf8'), 'CHANGED', 'a file already in the copy was copied over');
  // a batch of WT-2 and WT-1: the copy WT-1 has already is the batch's; WT-2 joins it
  const batch = await W.taskFolder(proj('wt'), [taskOf('wt', 2), taskOf('wt', 1)]);
  assert.equal(batch.path, copy);
  assert.equal(W.worktreeOf(taskOf('wt', 2).id).path, copy);
  const plain = await launch({ project: 'plain', keys: ['PL-1'] });
  assert.equal(plain.json().folder, join(tmp, 'plain'));
  assert.equal(plain.json().branch, undefined);
});

test('a copy whose folder was removed by hand is made again', async () => {
  const copy = join(repo, '.claude', 'worktrees', 'WT-1');
  rmSync(copy, { recursive: true, force: true });
  const r = await W.taskFolder(proj('wt'), [taskOf('wt', 1)]);
  assert.equal(r.path, copy);
  assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/WT-1', 'not a copy of the repository again');
});

test('a project that is a folder of a bigger repository: the copy is of the repository, Claude starts in the same folder of it', async () => {
  const r = await W.taskFolder(proj('web'), [taskOf('web', 1)]);
  assert.equal(r.path, join(mono, '.claude', 'worktrees', 'WB-1', 'apps', 'web'));
  assert.ok(existsSync(join(r.path, 'app.js')));
  assert.equal(git(mono, 'status', '--porcelain'), '', 'the monorepo\'s own exclude did not get the line');
  assert.ok(!existsSync(join(tmp, '.git')), 'an exclude file was made outside the repository');
});

test('«Continue» starts the session again in the copy it worked in', async () => {
  const t = db.prepare("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'wt' AND t.task_no = 1").get();
  db.prepare('INSERT OR IGNORE INTO board_sessions (session_id) VALUES (?)').run(SID);
  db.prepare('INSERT OR IGNORE INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(t.id, SID);
  const r = await launch({ project: 'wt', keys: ['WT-1'], resume: SID, text: undefined });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().folder, join(repo, '.claude', 'worktrees', 'WT-1'));
});

test('a path that is not «copy/link» inside the project is refused; kb show names the copy, kb info how it ships', async () => {
  for (const bad of ['rm -rf /', 'copy /etc/passwd', 'link ../outside']) {
    const r = await app.inject({ method: 'PATCH', url: '/api/projects/wt', payload: { worktree_files: bad } });
    assert.equal(r.statusCode, 400, bad);
    assert.equal(r.json().field, 'worktree_files');
  }
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/projects/wt', payload: { worktree_files: '# comment\ncopy .env\n\nlink node_modules' } })).statusCode, 200);
  const show = await kb(['show', 'WT-1']);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /^worktree: .*\/\.claude\/worktrees\/WT-1 \(branch claude\/WT-1\) — work and commit there/m);
  const info = await kb(['info', 'wt']);
  assert.match(info.stdout, /^worktrees: each task works in its own copy/m);
  assert.match(info.stdout, /^worktree setup: run in a fresh copy before work — npm install$/m);
  assert.doesNotMatch((await kb(['info', 'plain'])).stdout, /worktree/);
});

// before this one is shipped and must see its code; off the switch, each task keeps a copy of its own
test('tasks of an epic that runs straight through work in the copy of the epic, whatever copy they had', async () => {
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'wt'), ?, ?, 'todo')");
  const epic = add.run(10, 'the epic').lastInsertRowid;
  const one = add.run(11, 'stage one').lastInsertRowid;
  const two = add.run(12, 'stage two').lastInsertRowid;
  const b1 = db.prepare("INSERT INTO epic_batches (epic_id, title, position) VALUES (?, 'One', 1)").run(epic).lastInsertRowid;
  const b2 = db.prepare("INSERT INTO epic_batches (epic_id, title, position) VALUES (?, 'Two', 2)").run(epic).lastInsertRowid;
  db.prepare('INSERT INTO batch_tasks (task_id, batch_id, position) VALUES (?, ?, 1)').run(one, b1);
  db.prepare('INSERT INTO batch_tasks (task_id, batch_id, position) VALUES (?, ?, 1)').run(two, b2);
  db.prepare('INSERT INTO epics (task_id, through) VALUES (?, 0)').run(epic);
  const own = await W.taskFolder(proj('wt'), [taskOf('wt', 11)]);
  assert.equal(own.branch, 'claude/WT-11', 'an epic not through gave its task the copy of the epic');
  db.prepare('UPDATE epics SET through = 1 WHERE task_id = ?').run(epic);
  const dry = await W.taskFolder(proj('wt'), [taskOf('wt', 11)], { dry: true });
  assert.equal(dry.branch, 'claude/WT-10');
  const first = await W.taskFolder(proj('wt'), [taskOf('wt', 11)]);
  assert.deepEqual([first.branch, first.path], ['claude/WT-10', join(repo, '.claude', 'worktrees', 'WT-10')]);
  writeFileSync(join(first.path, 'stage-one.txt'), 'done');
  git(first.path, 'add', '.');
  git(first.path, 'commit', '-q', '-m', 'WT-11 stage one');
  const next = await W.taskFolder(proj('wt'), [taskOf('wt', 12)]);
  assert.equal(next.path, first.path, 'the next batch of the epic got a copy of its own');
  assert.equal(readFileSync(join(next.path, 'stage-one.txt'), 'utf8'), 'done', 'the next batch does not see the code of the one before');
  assert.equal(W.worktreeOf(one).branch, 'claude/WT-10', 'a task with a copy of its own stayed in it');
  assert.equal(W.worktreeOf(two).branch, 'claude/WT-10');
});
