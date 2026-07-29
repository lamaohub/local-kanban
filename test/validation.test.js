import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, doneAt;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Working','todo')").run(pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, done_at) VALUES (?,2,'Finished','done', datetime('now','-5 days'))").run(pid);
  doneAt = db.prepare("SELECT done_at FROM tasks WHERE task_no=2").get().done_at;

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/tasks', payload: { project: 'demo', ...payload } });
const patch = (key, payload) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload });

test('POST without a title is created from the description alone — 201', async () => {
  const r = await post({ description: 'description only, no title' });
  assert.equal(r.statusCode, 201);
  assert.equal(JSON.parse(r.body).title, '');
});

test('POST with title:null does not 500 — it becomes an empty string', async () => {
  const r = await post({ title: null, description: 'd' });
  assert.equal(r.statusCode, 201);
  assert.equal(JSON.parse(r.body).title, '');
});

test('listShape returns the attachments_n and comments_n counters', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=demo&all=1' });
  assert.equal(r.statusCode, 200);
  const list = r.json();
  assert.ok(list.length > 0);
  assert.ok(list.every((t) => typeof t.attachments_n === 'number'), 'every card carries attachments_n');
  assert.ok(list.every((t) => typeof t.comments_n === 'number'), 'every card carries comments_n');
  assert.ok(list.every((t) => t.attachments === undefined && t.comments === undefined),
    'the list must not carry attachments/comments — only the _n counters');
});

test('GET /api/tasks/:id returns a top-level status (the drawer resync fallback)', async () => {
  const t = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1' })).json();
  assert.equal(typeof t.status, 'string');
  assert.equal(t.status, 'todo');
});

test('POST priority outside 0-3 or non-numeric → 400', async () => {
  assert.equal((await post({ priority: 5 })).statusCode, 400);
  assert.equal((await post({ priority: 1.5 })).statusCode, 400);
  assert.equal((await post({ priority: '2' })).statusCode, 400);
  assert.equal((await post({ priority: 2 })).statusCode, 201);
});

test('PATCH priority non-numeric → 400, an integer → 200', async () => {
  assert.equal((await patch('DM-1', { priority: '2' })).statusCode, 400);
  assert.equal((await patch('DM-1', { priority: 2 })).statusCode, 200);
});

test('labels that are not an array → 400; non-string items are filtered out', async () => {
  assert.equal((await post({ labels: 'bug' })).statusCode, 400);
  assert.equal((await patch('DM-1', { labels: { x: 1 } })).statusCode, 400);
  const r = await post({ labels: [1, 'bug', null, 'ui'] });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(JSON.parse(r.body).labels, ['bug', 'ui'], 'only strings remain');
});

test('moving todo → done directly is forbidden (400)', async () => {
  assert.equal((await patch('DM-1', { status: 'done' })).statusCode, 400);
});

test('a no-op PATCH status=done on an already-done task leaves done_at alone', async () => {
  const r = await patch('DM-2', { status: 'done' });
  assert.equal(r.statusCode, 200);
  const after = db.prepare("SELECT done_at FROM tasks WHERE task_no=2").get().done_at;
  assert.equal(after, doneAt, 'the completion date stayed put and did not jump to today');
});
