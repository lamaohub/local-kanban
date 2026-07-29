import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, key;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Task', 'todo')").run(pid);
  key = 'DM-1';

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const mv = (status) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload: { status } });
const statuses = () => db.prepare('SELECT status FROM task_events WHERE task_id=1 ORDER BY id').all().map((e) => e.status);

test('a fresh task with no transitions has an empty log (Created comes from created_at)', () => {
  assert.deepEqual(statuses(), []);
});

test('every transition writes exactly one row to the log', async () => {
  await mv('doing');
  assert.deepEqual(statuses(), ['doing']);
  await mv('review');
  assert.deepEqual(statuses(), ['doing', 'review']);
});

test('a review→doing→review cycle adds rows, it is not a bug', async () => {
  await mv('doing');
  await mv('review');
  assert.deepEqual(statuses(), ['doing', 'review', 'doing', 'review']);
  assert.equal(statuses().filter((s) => s === 'doing').length, 2);
});

test('PATCHing the same status again does not add a duplicate', async () => {
  const before = statuses().length;
  await mv('review');
  assert.equal(statuses().length, before);
});

test('done is logged, done_at is set and the timer is closed after the cycles', async () => {
  const r = await mv('done');
  assert.equal(r.statusCode, 200);
  assert.equal(statuses().at(-1), 'done');
  const t = db.prepare('SELECT work_seconds, work_started_at, done_at FROM tasks WHERE id=1').get();
  assert.ok(t.done_at, 'done_at must be set');
  assert.equal(t.work_started_at, null, 'the timer is stopped');
  assert.ok(t.work_seconds >= 0, 'work time accumulated correctly across the cycles');
});

test('GET /api/tasks/:key returns events[] in order plus created_at for the Created row', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/tasks/${key}` });
  assert.equal(r.statusCode, 200);
  const t = r.json();
  assert.ok(t.created_at, 'created_at is what the front end needs for the Created row');
  assert.deepEqual(t.events.map((e) => e.status), ['doing', 'review', 'doing', 'review', 'done']);
  assert.ok(t.events.every((e) => e.created_at), 'every event has a timestamp');
});
