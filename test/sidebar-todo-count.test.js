// The grey dot and the number at a project row of the sidebar are its tasks in To do, read from `c_todo` of
// GET /api/projects. The row is held by test/sidebar-working.test.js; this file holds the number the row is fed:
// every task in To do counts (a blocked one and one done by hand too: the column shows them), nothing else does, and
// an archived project is not in the list. The Claude review row keeps the dot and the number of what waits for a check.
// Run: node --test. The database is isolated with KB_DATA_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, db, tmp, root;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-todo-count-'));
  root = mkdtempSync(join(tmpdir(), 'kb-todo-root-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = root;
  ({ db } = await import('../src/db.js'));
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  app = Fastify();
  await app.register(projectRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KB_LOCAL_ROOT;
  for (const d of [tmp, root]) if (d) rmSync(d, { recursive: true, force: true });
});

const STATUSES = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review', 'done', 'cancelled'];
let no = 0;
const addTask = (projectId, status, extra = {}) => db.prepare(
  'INSERT INTO tasks (project_id, task_no, title, status, labels, blocked) VALUES (?, ?, ?, ?, ?, ?)',
).run(projectId, ++no, `t${no}`, status, JSON.stringify(extra.labels || []), extra.blocked ? 1 : 0);

test('c_todo counts every task in To do of the project and nothing else; an archived project is not listed', async () => {
  for (const slug of ['todo-a', 'todo-b', 'todo-old']) {
    const r = await app.inject({ method: 'POST', url: '/api/projects', payload: { slug, name: slug } });
    assert.equal(r.statusCode, 201, r.body);
  }
  const id = (slug) => db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
  // a: one of each status, plus a blocked one and a manual one in To do
  for (const s of STATUSES) addTask(id('todo-a'), s);
  addTask(id('todo-a'), 'todo', { blocked: true });
  addTask(id('todo-a'), 'todo', { labels: ['noclaude'] });
  addTask(id('todo-a'), 'review', { labels: ['check'] });
  // b: nothing in To do, work elsewhere
  for (const s of ['backlog', 'prep', 'doing', 'review', 'done']) addTask(id('todo-b'), s);
  // old: tasks in To do, then archived
  addTask(id('todo-old'), 'todo');
  addTask(id('todo-old'), 'todo');
  db.prepare('UPDATE projects SET archived = 1 WHERE slug = ?').run('todo-old');

  const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json();
  const by = Object.fromEntries(list.map((p) => [p.slug, p]));
  assert.equal(by['todo-a'].c_todo, 3, 'the To do count of a project is not the tasks lying in To do (a blocked and a manual one count)');
  assert.equal(by['todo-b'].c_todo, 0, 'tasks outside To do are counted as To do');
  assert.equal(by['todo-a'].c_review, 2);
  assert.equal(by['todo-a'].c_review_check, 1);
  assert.ok(!by['todo-old'], 'an archived project is in the sidebar list');
});

test('the Claude review row keeps its grey dot and number: tasks in review less reports of checks', () => {
  const side = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
  assert.match(side, /const inReview = state\.projects\.reduce\(\(s, p\) => s \+ \(p\.c_review \|\| 0\) - \(p\.c_review_check \|\| 0\), 0\);/,
    'the Claude review row does not count the tasks waiting for a check');
  const at = side.indexOf("tr('Claude review')");
  assert.ok(at > 0, 'the Claude review row is gone');
  const row = side.slice(at, at + 400);
  assert.match(row, /\$\{inReview \? `<span class="proj-review"/, 'the grey dot of what waits for a check is gone from the Claude review row');
  assert.match(row, /<span class="proj-counts">\$\{inReview \|\| ''\}<\/span>/, 'the number of what waits for a check is gone from the Claude review row');
});
