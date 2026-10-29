import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',4)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'todo')").run(pid, n, `Task ${n}`);

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const post = (id, key) => app.inject({ method: 'POST', url: `/api/tasks/${id}/links`, payload: { key } });
const linksOf = async (key) => (await app.inject({ method: 'GET', url: `/api/tasks/${key}` })).json().links;

test('a link is created and is symmetric (visible from both sides)', async () => {
  const r = await post('DM-1', 'DM-2');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().map((l) => l.key), ['DM-2']);
  assert.deepEqual((await linksOf('DM-1')).map((l) => l.key), ['DM-2']);
  assert.deepEqual((await linksOf('DM-2')).map((l) => l.key), ['DM-1']);
});

test('linking twice does not create a duplicate', async () => {
  await post('DM-2', 'DM-1');
  assert.equal((await linksOf('DM-1')).length, 1);
});

test('a task cannot be linked to itself — 400', async () => {
  assert.equal((await post('DM-1', 'DM-1')).statusCode, 400);
});

test('linking to a missing task is a 404', async () => {
  assert.equal((await post('DM-1', 'DM-99')).statusCode, 404);
});

test('the task list returns linked_ids (ids only) for drawing the lines', async () => {
  const list = (await app.inject({ method: 'GET', url: '/api/tasks?project=DM&all=1' })).json();
  const t1 = list.find((t) => t.key === 'DM-1');
  const t2 = list.find((t) => t.key === 'DM-2');
  assert.ok(t1.linked_ids.includes(t2.id) && t2.linked_ids.includes(t1.id));
  assert.equal(t1.links, undefined, 'the list must not carry a links field');
});

test('DELETE removes the link', async () => {
  const other = (await linksOf('DM-1'))[0].id;
  const r = await app.inject({ method: 'DELETE', url: `/api/tasks/DM-1/links/${other}` });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(await linksOf('DM-1'), []);
});

test('deleting a task cascades to its links', async () => {
  await post('DM-1', 'DM-3');
  assert.equal((await linksOf('DM-1')).length, 1);
  await app.inject({ method: 'DELETE', url: '/api/tasks/DM-3' });
  assert.equal((await linksOf('DM-1')).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_links').get().n, 0);
});

test('a directed link is removed when the parent id is GREATER than the subtask id', async () => {
  db.prepare('DELETE FROM task_links').run();
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-2/links', payload: { key: 'DM-1', rel: 'child' } });
  assert.equal(r.statusCode, 200);
  const row = db.prepare('SELECT * FROM task_links').get();
  const idOf = (k) => db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(Number(k.split('-')[1])).id;
  assert.equal(row.kind, 'parent');
  assert.ok(row.task_id > row.linked_task_id, 'precondition: the parent id is greater than the child id');

  const del = await app.inject({ method: 'DELETE', url: `/api/tasks/DM-2/links/${idOf('DM-1')}` });
  assert.equal(del.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_links').get().n, 0, 'the link must be gone');
});

test('a directed link is removed from the subtask side too', async () => {
  db.prepare('DELETE FROM task_links').run();
  await app.inject({ method: 'POST', url: '/api/tasks/DM-2/links', payload: { key: 'DM-1', rel: 'child' } });
  const parentId = db.prepare('SELECT task_id FROM task_links').get().task_id;
  const del = await app.inject({ method: 'DELETE', url: `/api/tasks/DM-1/links/${parentId}` });
  assert.equal(del.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_links').get().n, 0);
});

test('the task list of more than 16 384 tasks still answers, and its links are still there', async () => {
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('bulk','BK','bulk',1)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='bulk'").get().id;
  const N = 16_500;
  const ins = db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, ?)');
  db.transaction(() => { for (let n = 1; n <= N; n++) ins.run(pid, n, `Bulk ${n}`, n % 2 ? 'done' : 'backlog'); })();
  const idOf = (no) => db.prepare('SELECT id FROM tasks WHERE project_id = ? AND task_no = ?').get(pid, no).id;
  const [first, last] = [idOf(1), idOf(N)];
  db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'related')").run(first, last);
  for (const url of ['/api/tasks?all=1', '/api/tasks?project=bulk&all=1']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 200, `${url}: ${r.body.slice(0, 200)}`);
    const byId = new Map(r.json().map((t) => [t.id, t]));
    assert.ok(byId.size >= N, `${url}: ${byId.size} tasks instead of ${N}+`);
    assert.deepEqual(byId.get(first).linked_ids, [last], `${url}: the first task lost its link`);
    assert.deepEqual(byId.get(last).linked_ids, [first], `${url}: the last task lost its link`);
  }
});

test('a project board keeps a link whose stored row starts at a task of another project', async () => {
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('other','OT','other',2)").run();
  const oid = db.prepare("SELECT id FROM projects WHERE slug='other'").get().id;
  const parent = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Parent elsewhere', 'todo')").run(oid).lastInsertRowid;
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-1/links', payload: { key: 'OT-1', rel: 'parent' } });
  assert.equal(r.statusCode, 200);
  const dm1 = db.prepare("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'demo' AND t.task_no = 1").get().id;
  const row = db.prepare('SELECT task_id, linked_task_id FROM task_links WHERE linked_task_id = ? OR task_id = ?').get(dm1, dm1);
  assert.deepEqual(row, { task_id: parent, linked_task_id: dm1 }, 'precondition: the row starts at the task of the other project');
  const list = (await app.inject({ method: 'GET', url: '/api/tasks?project=demo&all=1' })).json();
  assert.deepEqual(list.find((t) => t.id === dm1).linked_ids, [parent], 'the card lost its link to the task of another project');
});
