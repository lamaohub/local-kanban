// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { notOnMain, showsShip, SHIP_WORDS } from '../public/js/shipped-rules.js';

let app, tmp, repo, db, forgetShipped, pid, n = 0;
const git = (...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...a], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (message, file = `f${(n += 1)}`) => { writeFileSync(join(repo, file), String(n)); git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
const task = (no, status = 'review', extra = {}) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels, gh_issue_number) VALUES (?, ?, ?, ?, ?, ?)')
  .run(pid, no, 'T', status, extra.labels || '[]', extra.issue ?? null).lastInsertRowid;
const look = async (q = '?project=demo') => { forgetShipped(); return (await app.inject({ method: 'GET', url: `/api/shipped${q}` })).json().tasks; };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  repo = mkdtempSync(join(tmpdir(), 'kb-ship-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ forgetShipped } = await import('../src/shipped.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  git('init', '-q', '-b', 'main');
  commit('first');
  pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('demo','DM','demo',100,?)").run(repo).lastInsertRowid;
  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); for (const d of [tmp, repo]) if (d) rmSync(d, { recursive: true, force: true }); });

test('by the key, by the issue, and by the commit hung on the card', async () => {
  task(1); task(2, 'review', { issue: 77 }); const third = task(3); task(4, 'ready');
  commit('fix the login (DM-1)');
  commit('another (lamaohub/server-comp#77)');
  const hash = commit('a message that names no task');
  db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'git', ?)").run(third, `${hash.slice(0, 10)} a message\n1 file changed`);
  const t = await look();
  assert.equal(t['DM-1'], 'main');
  assert.equal(t['DM-2'], 'main');
  assert.equal(t['DM-3'], 'main');
  assert.equal(t['DM-4'], 'none', 'a task with no commit');
});

test('a commit on a branch only is said so, and a key is not a part of a longer one', async () => {
  task(5); task(50);
  git('checkout', '-q', '-b', 'claude/work');
  commit('half of it (DM-50)');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-50'], 'branch');
  assert.equal(t['DM-5'], 'none', 'DM-50 was read as DM-5');
});

test('a cherry-picked copy on main: the original left on its branch does not count as unshipped', async () => {
  task(6);
  git('checkout', '-q', '-b', 'claude/picked');
  const h = commit('picked work (DM-6)');
  git('checkout', '-q', 'main');
  commit('main went on');
  git('cherry-pick', h);
  assert.equal((await look())['DM-6'], 'main');
});

test('partly shipped is not shipped: a later commit still on a branch says branch', async () => {
  task(7);
  commit('first part (DM-7)');
  git('checkout', '-q', '-b', 'claude/more');
  commit('second part (DM-7)');
  git('checkout', '-q', 'main');
  assert.equal((await look())['DM-7'], 'branch');
});

test('the branch of the task counts without the key in any message, whatever its name around the key', async () => {
  task(8); task(14);
  git('checkout', '-q', '-b', 'claude/DM-8');
  commit('no key here');
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'claude/skill-dm-14-a1b2c3');
  commit('nor here');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-8'], 'branch');
  assert.equal(t['DM-14'], 'branch');
});

test('a branch of the task with nothing of its own says nothing: the work may never have been committed', async () => {
  task(9);
  git('branch', 'claude/DM-9');
  assert.equal((await look())['DM-9'], 'none', 'a branch made and left empty read as on main');
});

test('the branch of the task, cherry-picked whole: on main, though the hashes differ', async () => {
  task(15);
  git('checkout', '-q', '-b', 'claude/DM-15');
  const h = commit('no key in it either');
  git('checkout', '-q', 'main');
  commit('main went on'); // within one second a pick on the same parent would be the very same commit
  git('cherry-pick', h);
  assert.equal((await look())['DM-15'], 'main');
});

test('the same subject with another patch is not a copy', async () => {
  task(16);
  commit('fix tests (DM-16)');
  git('checkout', '-q', '-b', 'claude/other');
  commit('fix tests (DM-16)');
  git('checkout', '-q', 'main');
  assert.equal((await look())['DM-16'], 'branch', 'a subject seen on main hid unshipped work');
});

test('a task done by hand and a check say nothing, nor a task out of these columns', async () => {
  task(10, 'review', { labels: '["noclaude"]' }); task(11, 'review', { labels: '["check"]' }); task(12, 'doing');
  commit('work (DM-12)');
  const t = await look();
  assert.deepEqual(['DM-10', 'DM-11', 'DM-12'].filter((k) => k in t), []);
});

test('origin/main is what counts when there is one', async () => {
  task(13);
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  commit('local only (DM-13)');
  assert.equal((await look())['DM-13'], 'branch', 'a commit not pushed reads as on main');
  git('update-ref', '-d', 'refs/remotes/origin/main');
});

test('a folder that is not a repository, or no folder: no word at all', async () => {
  const other = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('plain','PL','plain',5,?)").run(tmp).lastInsertRowid;
  const none = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('nopath','NP','nopath',5)").run().lastInsertRowid;
  for (const id of [other, none]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'review')").run(id);
  assert.deepEqual(await look('?project=plain'), {});
  assert.deepEqual(await look('?project=nopath'), {});
  const all = await look('');
  assert.equal(all['DM-1'], 'main', 'all the boards together');
});

test('an answer lives a while: two looks are one', async () => {
  const { shippedOf } = await import('../src/shipped.js');
  forgetShipped();
  const p = { id: pid, path: repo };
  assert.equal(shippedOf(p, 1000), shippedOf(p, 2000));
  assert.notEqual(shippedOf(p, 1000), shippedOf(p, 40000));
  forgetShipped();
});

test('a branch is the task\'s by the key as a word of its name', async () => {
  const { branchesOf, cherryState } = await import('../src/shipped.js');
  const names = ['claude/CK-5', 'origin/claude/ck-5', 'claude/skill-ck-5-ab12', 'claude/CK-50', 'claude/xck-5', 'claude/ck-5x'];
  assert.deepEqual(branchesOf('CK-5', names), ['claude/CK-5', 'origin/claude/ck-5', 'claude/skill-ck-5-ab12']);
  assert.equal(cherryState(''), null);
  assert.equal(cherryState('- abc\n- def\n'), 'in');
  assert.equal(cherryState('- abc\n+ def\n'), 'ahead');
});

test('what the card and the filter go by', () => {
  assert.equal(showsShip('review'), true);
  assert.equal(showsShip('ready'), true);
  assert.equal(showsShip('doing'), false);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'main' }), false);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'branch' }), true);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'none' }), true);
  assert.equal(notOnMain({ key: 'A-1' }, {}), true, 'not looked at yet is not known to be there');
  assert.deepEqual(Object.keys(SHIP_WORDS).sort(), ['branch', 'main', 'none']);
});
