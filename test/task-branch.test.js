// (git merge-tree, nothing written to the copy), and a pull request — the branch pushed to origin and `gh pr create`.
// A real git with a bare origin; gh is a stand-in (KB_GH_BIN) that writes down what it was asked and answers as gh does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: ENV }).trim();
let app, tmp, db, base, repo, origin, ghLog, W;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-br-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  origin = join(tmp, 'origin.git');
  execFileSync(fullPath('git'), ['init', '-q', '--bare', '-b', 'main', origin], { env: ENV });
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // gh: writes its arguments down; `pr create` prints the address, `pr view` the request as JSON
  ghLog = join(tmp, 'gh.log');
  const gh = join(tmp, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\ncase "$1 $2" in\n  "pr create") echo "https://github.com/me/repo/pull/7";;\n  "pr view") echo '{"number":7,"url":"https://github.com/me/repo/pull/7","state":"OPEN"}';;\nesac\n`);
  chmodSync(gh, 0o755);
  process.env.KB_GH_BIN = gh;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no, worktrees) VALUES ('br', 'BR', 'Branches', ?, 3, 1)").run(repo);
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES ((SELECT id FROM projects WHERE slug = 'br'), ?, ?, ?, 'doing')");
  add.run(1, 'Change the line', 'Make a.txt say two.'); add.run(2, 'Nothing yet', '');
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const task = (no) => db.prepare("SELECT t.*, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'br' AND t.task_no = ?").get(no);
const proj = () => db.prepare("SELECT * FROM projects WHERE slug = 'br'").get();

test('a task without a copy has no branch to show, and no pull request to open', async () => {
  assert.deepEqual((await app.inject('/api/tasks/BR-1/branch')).json(), { branch: null });
  const r = await app.inject({ method: 'POST', url: '/api/tasks/BR-1/pr', payload: {} });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'no-branch');
});

test('the branch of the copy: ahead of main, no conflict; nothing to ask for a branch with no commits of its own', async () => {
  const c1 = await W.taskFolder(proj(), [task(1)]);
  const c2 = await W.taskFolder(proj(), [task(2)]);
  writeFileSync(join(c1.path, 'a.txt'), 'two\n');
  git(c1.path, 'commit', '-q', '-am', 'BR-1 two');
  const b = (await app.inject('/api/tasks/BR-1/branch')).json();
  assert.deepEqual([b.branch, b.base, b.ahead, b.conflict, b.pr], ['claude/BR-1', 'main', 1, { files: [] }, null]);
  const none = await app.inject({ method: 'POST', url: '/api/tasks/BR-2/pr', payload: {} });
  assert.equal(none.json().reason, 'nothing');
  assert.equal((await app.inject('/api/tasks/BR-2/branch')).json().ahead, 0);
  assert.ok(c2.path);
});

test('a commit of main on the same line is a conflict, named by its file — and the copy is left as it was', async () => {
  writeFileSync(join(repo, 'a.txt'), 'three\n');
  git(repo, 'commit', '-q', '-am', 'main three');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const copy = W.worktreeOf(task(1).id).path;
  const head = git(copy, 'rev-parse', 'HEAD');
  const b = (await app.inject('/api/tasks/BR-1/branch')).json();
  assert.deepEqual(b.conflict, { files: ['a.txt'] });
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head);
  assert.equal(git(copy, 'status', '--porcelain'), '', 'the check wrote into the copy');
});

test('a pull request: the branch goes to origin, gh is asked with the card\'s words, the card and kb show name it', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/BR-1/pr', payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { url: 'https://github.com/me/repo/pull/7', number: 7, state: 'OPEN' });
  assert.equal(execFileSync(fullPath('git'), ['-C', origin, 'rev-parse', 'refs/heads/claude/BR-1'], { encoding: 'utf8' }).trim(), git(W.worktreeOf(task(1).id).path, 'rev-parse', 'HEAD'), 'the branch was not pushed');
  const asked = readFileSync(ghLog, 'utf8');
  assert.match(asked, /^pr create --base main --head claude\/BR-1 --title BR-1 Change the line --body Make a\.txt say two\.\n\n---\nTask BR-1 \(local-kanban\)$/m);
  assert.deepEqual((await app.inject('/api/tasks/BR-1')).json().pr, { url: 'https://github.com/me/repo/pull/7', number: 7, state: 'OPEN' });
  assert.equal((await app.inject('/api/tasks/BR-1/branch')).json().pr.number, 7);
  const shown = await new Promise((resolve) => execFile(process.execPath, [KB, 'show', 'BR-1'], { env: { ...process.env, KB_URL: base } }, (err, out) => resolve(out)));
  assert.match(shown, /^pr: https:\/\/github\.com\/me\/repo\/pull\/7 \(open\)$/m);
});

test('a file in conflict is named as it is — a space and Cyrillic, not git\'s «"dir x/\\321\\204…"»', async () => {
  const name = `dir x/${'\u0444\u0430\u0439\u043b'}.txt`; // Cyrillic written so that the source stays Latin (the release audit)
  const copy = W.worktreeOf(task(1).id).path;
  mkdirSync(join(repo, 'dir x'), { recursive: true });
  writeFileSync(join(repo, name), 'main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main odd name');
  git(repo, 'push', '-q', 'origin', 'main');
  mkdirSync(join(copy, 'dir x'), { recursive: true });
  writeFileSync(join(copy, name), 'the task\'s\n');
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', 'BR-1 odd name');
  assert.deepEqual((await app.inject('/api/tasks/BR-1/branch')).json().conflict, { files: ['a.txt', name] });
});

test('a guest of the Wi-Fi gets neither the branch nor a pull request', async () => {
  const { ownerOnly } = await import('../src/share.js');
  assert.equal(ownerOnly('GET', '/api/tasks/:id/branch'), true);
  assert.equal(ownerOnly('POST', '/api/tasks/:id/pr'), true);
});
