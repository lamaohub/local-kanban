// stream: a line of 5 MB went to the page whole (WebKit hung for minutes), a diff of 49 MB held 300+ MB of the board,
// and one past 64 MB lost its commit without a word. New files git does not know yet are part of what is not committed;
// a project that is one folder of a bigger repository sees its paths from its own folder; a name with « b/», a quote
// or a line break in it is read whole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (dir, ...a) => execFileSync(fullPath('git'), ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV }, maxBuffer: 64 * 1024 * 1024 }).trim();
let tmp, db, app, C, W;
const projects = {};

function repoAt(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  return dir;
}
let no = 0;
async function copyFor(dir, slug, path = dir) {
  if (!projects[slug]) {
    db.prepare("INSERT INTO projects (slug, prefix, name, path, worktrees) VALUES (?, ?, ?, ?, 1)").run(slug, slug.toUpperCase(), slug, path);
    projects[slug] = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  }
  no += 1;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 't', 'doing')").run(projects[slug].id, no);
  const t = db.prepare("SELECT t.*, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ? AND t.task_no = ?").get(slug, no);
  return { key: t.key, path: (await W.taskFolder(projects[slug], [t])).path };
}
const changes = async (key) => {
  const r = await app.inject(`/api/tasks/${key}/changes`);
  assert.equal(r.statusCode, 200, r.body);
  return { body: r.body, ...r.json() };
};
const lines = (data) => [...data.commits, ...(data.uncommitted ? [data.uncommitted] : [])].flatMap((p) => p.files).flatMap((f) => f.hunks).flatMap((h) => h.lines);
const many = (n, w = 10) => Array.from({ length: n }, (_, i) => `${String(i).padStart(w, '0')}`).join('\n') + '\n';

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-chl-')));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), ...ENV });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  ({ db } = await import('../src/db.js'));
  C = await import('../src/task-changes.js');
  W = await import('../src/worktrees.js');
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/branch.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('a line of 5 MB comes cut to LINE_CHARS_MAX with a mark — the answer stays small', async () => {
  const repo = repoAt('long');
  const { key, path } = await copyFor(repo, 'lo');
  writeFileSync(join(path, 'min.js'), `${'x'.repeat(5 * 1024 * 1024)}\nshort\n`);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'a minified file');
  const data = await changes(key);
  const [long, short] = data.commits[0].files[0].hunks[0].lines;
  assert.equal(long.text.length, C.LINE_CHARS_MAX);
  assert.equal(long.cut, true, 'the cut line is not marked');
  assert.deepEqual([short.text, short.cut], ['short', undefined]);
  assert.ok(data.body.length < 100_000, `the answer is ${data.body.length} bytes`);
});

test('a commit past 64 MB of diff stays in the list: its large file named, its other files shown', async () => {
  const repo = repoAt('huge');
  const { key, path } = await copyFor(repo, 'hu');
  const fd = openSync(join(path, 'dump.sql'), 'w');
  const row = `${'y'.repeat(1000)}\n`;
  const chunk = row.repeat(1000);
  for (let i = 0; i < 70; i += 1) writeSync(fd, chunk); // 70 000 lines, 70 MB
  closeSync(fd);
  writeFileSync(join(path, 'small.js'), 'one\ntwo\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'a dump and a small file');
  const rss = process.memoryUsage().rss;
  const data = await changes(key);
  assert.equal(data.commits.length, 1, 'the commit is gone from the list');
  const files = Object.fromEntries(data.commits[0].files.map((f) => [f.path, f]));
  assert.deepEqual([files['dump.sql']?.big, files['dump.sql']?.add, files['dump.sql']?.hunks.length], [true, 70000, 0]);
  assert.deepEqual(files['small.js']?.hunks[0].lines.map((l) => l.text), ['one', 'two']);
  assert.ok(process.memoryUsage().rss - rss < 200 * 1024 * 1024, 'the board held the whole diff');
});

test('COMMITS_MAX, FILES_MAX and LINES_MAX hold — and what they cut is said', async () => {
  const repo = repoAt('limits');
  const { key, path } = await copyFor(repo, 'li');
  for (let i = 0; i <= C.COMMITS_MAX; i += 1) {
    writeFileSync(join(path, 'n.txt'), `${i}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', `step ${i}`);
  }
  let data = await changes(key);
  assert.equal(data.commits.length, C.COMMITS_MAX);
  assert.equal(data.cut, true, 'the commits past COMMITS_MAX are not said to be cut');
  // FILES_MAX: one commit of more files than the answer takes
  const wide = (await copyFor(repo, 'li')).path;
  for (let i = 0; i <= C.FILES_MAX; i += 1) writeFileSync(join(wide, `f${String(i).padStart(3, '0')}.txt`), 'x\n');
  git(wide, 'add', '.');
  git(wide, 'commit', '-q', '-m', 'wide');
  data = await changes(`LI-${no}`);
  assert.equal(data.commits[0].files.length, C.FILES_MAX);
  assert.deepEqual([data.commits[0].cut, data.cut], [true, true]);
  // LINES_MAX: three files under FILE_LINES_MAX each, more lines than the answer takes together — and the commit after
  // the budget is spent is still listed, not read
  const tall = (await copyFor(repo, 'li')).path;
  const each = Math.floor(C.FILE_LINES_MAX * 0.9);
  assert.ok(each * 3 > C.LINES_MAX && each <= C.FILE_LINES_MAX);
  for (const n of ['a', 'b', 'c']) writeFileSync(join(tall, `${n}.txt`), many(each));
  git(tall, 'add', '.');
  git(tall, 'commit', '-q', '-m', 'tall');
  writeFileSync(join(tall, 'later.txt'), 'later\n');
  git(tall, 'add', '.');
  git(tall, 'commit', '-q', '-m', 'later');
  writeFileSync(join(tall, 'loose.txt'), 'not committed\n');
  data = await changes(`LI-${no}`);
  assert.equal(lines(data).length, C.LINES_MAX);
  assert.deepEqual(data.commits.map((c) => [c.subject, c.cut ?? false, c.files.length]), [['later', false, 1], ['tall', true, 3]]);
  assert.equal(data.cut, true);
  assert.equal(data.commits[1].files.at(-1).cut, true, 'the file cut short is not marked');
});

test('a commit the budget did not reach stays listed, unread and marked', async () => {
  const repo = repoAt('unread');
  const { key, path } = await copyFor(repo, 'un');
  const each = Math.floor(C.FILE_LINES_MAX * 0.9);
  writeFileSync(join(path, 'old.txt'), 'x\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'oldest');
  for (const n of ['a', 'b', 'c']) {
    writeFileSync(join(path, `${n}.txt`), many(each));
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', `big ${n}`);
  }
  writeFileSync(join(path, 'first.txt'), 'x\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'newest');
  const data = await changes(key);
  assert.deepEqual(data.commits.map((c) => [c.subject, Boolean(c.cut), c.files.length]), [['newest', false, 1], ['big c', false, 1], ['big b', false, 1], ['big a', true, 1], ['oldest', true, 0]]);
});

test('a new file git does not know is in «Not committed yet», an ignored one is not, and the index is left alone', async () => {
  const repo = repoAt('fresh');
  writeFileSync(join(repo, '.gitignore'), 'secret.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'ignore');
  const { key, path } = await copyFor(repo, 'fr');
  writeFileSync(join(path, 'fresh.js'), 'export const x = 1;\n');
  writeFileSync(join(path, 'secret.env'), 'TOKEN=1\n');
  const data = await changes(key);
  assert.deepEqual(data.uncommitted?.files.map((f) => [f.path, f.untracked, f.add, f.hunks[0]?.lines.map((l) => l.t + l.text)]),
    [['fresh.js', true, 1, ['+export const x = 1;']]], 'the new file is not shown (or the ignored one is)');
  assert.equal(git(path, 'status', '--porcelain'), '?? fresh.js', 'the index was touched');
});

test('a project in a folder of a bigger repository: paths from its own folder, the editor opens a file that is there', async () => {
  const top = repoAt('mono');
  mkdirSync(join(top, 'apps', 'web'), { recursive: true });
  writeFileSync(join(top, 'apps', 'web', 'page.js'), 'one\n');
  writeFileSync(join(top, 'root.txt'), 'top\n');
  git(top, 'add', '.');
  git(top, 'commit', '-q', '-m', 'mono');
  const { key, path } = await copyFor(top, 'mo', join(top, 'apps', 'web'));
  writeFileSync(join(path, 'page.js'), 'two\n');
  writeFileSync(join(path, 'new.js'), 'n\n');
  git(path, 'add', 'page.js');
  git(path, 'commit', '-q', '-m', 'MO page');
  writeFileSync(join(path, 'page.js'), 'three\n');
  writeFileSync(join(top, '.claude', 'worktrees', key, 'root.txt'), 'outside the project\n');
  const data = await changes(key);
  assert.equal(data.folder, path);
  assert.deepEqual(data.commits[0].files.map((f) => f.path), ['page.js'], 'a path from the top of the repository');
  assert.deepEqual(data.uncommitted.files.map((f) => f.path), ['page.js', 'new.js']);
  const { existsSync } = await import('node:fs');
  for (const f of data.uncommitted.files) assert.ok(existsSync(join(data.folder, f.path)), `${data.folder}/${f.path} is not a file`);
});

test('names read whole: « b/» in a folder, a quote and a line break in a name; removed and renamed ones too', async () => {
  const repo = repoAt('names');
  const { key, path } = await copyFor(repo, 'nm');
  mkdirSync(join(path, 'x b'));
  writeFileSync(join(path, 'x b', 'c.js'), 'c\n');
  writeFileSync(join(path, 'q"t.js'), 'q\n');
  writeFileSync(join(path, 'line\nbreak.js'), 'l\n');
  writeFileSync(join(path, 'gone.js'), 'g\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'names');
  git(path, 'rm', '-q', 'gone.js');
  git(path, 'mv', 'q"t.js', 'r"n.js');
  git(path, 'commit', '-q', '-m', 'remove and rename');
  const data = await changes(key);
  const [second, first] = data.commits;
  assert.deepEqual(first.files.map((f) => f.path).sort(), ['gone.js', 'line\nbreak.js', 'q"t.js', 'x b/c.js']);
  assert.deepEqual(second.files.map((f) => [f.path, f.old]).sort(), [['gone.js', null], ['r"n.js', 'q"t.js']]);
  assert.deepEqual(C.parseDiff('diff --git a/x b/y.js b/x b/y.js\n--- a/x b/y.js\n+++ b/x b/y.js\n@@ -1 +1 @@\n-a\n+b')[0].path, 'x b/y.js');
  assert.equal(C.unquote('"d\\303\\251j\\303\\240 \\"vu\\"\\n.js"'), 'déjà "vu"\n.js');
});
