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

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, done_at) VALUES (?, 1, 'Finished', 'done', datetime('now'))").run(pid);

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const create = (status) => app.inject({ method: 'POST', url: '/api/tasks', payload: { project: 'demo', title: 'X', status } });

test('a task cannot be created straight into done — 400', async () => {
  const r = await create('done');
  assert.equal(r.statusCode, 400);
});

test('a task cannot be created straight into cancelled — 400', async () => {
  const r = await create('cancelled');
  assert.equal(r.statusCode, 400);
});

test('a task cannot be created straight into review — 400', async () => {
  assert.equal((await create('review')).statusCode, 400);
});

test('a task cannot be created in the working columns (prep/doing/deploy) — 400', async () => {
  assert.equal((await create('prep')).statusCode, 400);
  assert.equal((await create('doing')).statusCode, 400);
  assert.equal((await create('deploy')).statusCode, 400);
});

test('a task can be created in backlog/todo — 201', async () => {
  assert.equal((await create('backlog')).statusCode, 201);
  assert.equal((await create('todo')).statusCode, 201);
});

test('duplicating a done task puts the copy in todo, not in done', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-1/duplicate' });
  assert.equal(r.statusCode, 201);
  assert.equal(JSON.parse(r.body).status, 'todo');
});

test('duplicating a review task also puts the copy in todo', async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 50, 'In review', 'review')").run(pid);
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-50/duplicate' });
  assert.equal(r.statusCode, 201);
  assert.equal(JSON.parse(r.body).status, 'todo');
});
