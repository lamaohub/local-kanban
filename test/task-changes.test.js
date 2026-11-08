import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';
import { addRemark, remarksMessage } from '../public/js/changes-rules.js';

const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
let tmp, db, app, C, W, repo, shared;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-ch-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), ...ENV });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.js'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  shared = join(tmp, 'shared');
  mkdirSync(shared);
  git(shared, 'init', '-q', '-b', 'main');
  writeFileSync(join(shared, 'b.js'), 'x\n');
  git(shared, 'add', '.');
  git(shared, 'commit', '-q', '-m', 'start');
  writeFileSync(join(shared, 'b.js'), 'x\ny\n');
  git(shared, 'commit', '-q', '-am', 'SH-1 add y');
  writeFileSync(join(shared, 'c.js'), 'other\n');
  git(shared, 'add', '.');
  git(shared, 'commit', '-q', '-m', 'SH-2 another task');
  writeFileSync(join(shared, 'b.js'), 'x\ny\nz\n'); // not committed
  ({ db } = await import('../src/db.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, path, worktrees) VALUES ('cp', 'CP', 'Copies', ?, 1)").run(repo);
  db.prepare("INSERT INTO projects (slug, prefix, name, path) VALUES ('sh', 'SH', 'Shared', ?)").run(shared);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'cp'), 1, 'c', 'doing')").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'sh'), 1, 's', 'doing')").run();
  C = await import('../src/task-changes.js');
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('a diff read into files, hunks and lines with their numbers on each side', () => {
  const files = C.parseDiff([
    'diff --git a/src/x.js b/src/x.js', 'index 1..2 100644', '--- a/src/x.js', '+++ b/src/x.js',
    '@@ -1,3 +1,3 @@ function f() {', ' keep', '-old line', '+new line', ' tail', '\\ No newline at end of file',
    'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
    'diff --git a/old.js b/new.js', 'similarity index 90%', 'rename from old.js', 'rename to new.js',
  ].join('\n'));
  assert.deepEqual(files.map((f) => [f.path, f.add, f.del, f.binary, f.old]), [['src/x.js', 1, 1, false, null], ['img.png', 0, 0, true, null], ['new.js', 0, 0, false, 'old.js']]);
  assert.deepEqual(files[0].hunks[0].lines, [
    { t: ' ', text: 'keep', old: 1, new: 1 }, { t: '-', text: 'old line', old: 2, new: null },
    { t: '+', text: 'new line', old: null, new: 2 }, { t: ' ', text: 'tail', old: 3, new: 3 }]);
});

test('a task with its own copy: the commits of its branch, then what is not committed — nothing of main', async () => {
  const task = db.prepare("SELECT t.*, 'CP-1' AS key FROM tasks t WHERE task_no = 1 AND project_id = (SELECT id FROM projects WHERE slug = 'cp')").get();
  const copy = (await W.taskFolder(db.prepare("SELECT * FROM projects WHERE slug = 'cp'").get(), [task])).path;
  writeFileSync(join(copy, 'a.js'), 'one\nTWO\nthree\n');
  git(copy, 'commit', '-q', '-am', 'CP-1 shout');
  writeFileSync(join(copy, 'new.js'), 'n\n');
  git(copy, 'add', 'new.js');
  writeFileSync(join(repo, 'a.js'), 'one\ntwo\nthree\nfour\n'); // main moves on meanwhile — not the task's
  git(repo, 'commit', '-q', '-am', 'main four');
  const r = (await app.inject('/api/tasks/CP-1/changes')).json();
  assert.equal(r.source, 'copy');
  assert.equal(r.branch, 'claude/CP-1');
  assert.deepEqual(r.commits.map((c) => [c.subject, c.files.map((f) => f.path)]), [['CP-1 shout', ['a.js']]]);
  assert.deepEqual(r.commits[0].files[0].hunks[0].lines.filter((l) => l.t !== ' ').map((l) => [l.t, l.text, l.old ?? l.new]), [['-', 'two', 2], ['+', 'TWO', 2]]);
  assert.deepEqual(r.uncommitted.files.map((f) => f.path), ['new.js']);
  assert.equal(r.uncommitted.shared, false);
});

test('a task in a shared folder: its own commits by its key, the folder\'s uncommitted marked as shared', async () => {
  const r = (await app.inject('/api/tasks/SH-1/changes')).json();
  assert.equal(r.source, 'folder');
  assert.deepEqual(r.commits.map((c) => c.subject), ['SH-1 add y'], 'another task\'s commit came along');
  assert.deepEqual(r.uncommitted.files.map((f) => f.path), ['b.js']);
  assert.equal(r.uncommitted.shared, true);
  const { ownerOnly } = await import('../src/share.js');
  assert.equal(ownerOnly('GET', '/api/tasks/:id/changes'), true, 'a guest of the Wi-Fi read the owner\'s code');
});

test('the remarks: one per line, sent as one message with the place, the code and the words', () => {
  let list = [];
  list = addRemark(list, { file: 'a.js', line: 2, code: 'TWO', text: 'keep it lower case' });
  list = addRemark(list, { file: 'a.js', line: 2, code: 'TWO', text: 'lower case, please' });
  list = addRemark(list, { file: 'b.js', line: 7, removed: true, code: 'return x;', text: 'why was this removed?' });
  assert.equal(list.length, 2, 'a second remark on the same line stood next to the first');
  const tr = (s) => `«${s}»`;
  assert.equal(remarksMessage('CP-1', list, tr), [
    '«Remarks on the changes of {key} — fix each, then tell me what you did:»'.replace('{key}', 'CP-1'),
    '- a.js:2 `TWO` — lower case, please',
    '- b.js:7 («a removed line») `return x;` — why was this removed?',
  ].join('\n'));
});
