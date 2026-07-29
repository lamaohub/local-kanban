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
const row = () => db.prepare('SELECT status, work_started_at, work_seconds FROM tasks WHERE id=1').get();

test('the schema accepts prep (the CHECK does not fail)', async () => {
  const r = await mv('prep');
  assert.equal(r.statusCode, 200);
  assert.equal(row().status, 'prep');
});

test('in prep the timer is NOT running (work_started_at = null)', () => {
  assert.equal(row().work_started_at, null);
});

test('prep→doing starts the timer', async () => {
  const r = await mv('doing');
  assert.equal(r.statusCode, 200);
  assert.notEqual(row().work_started_at, null);
});

test('the move into prep is recorded in the status log', () => {
  const evs = db.prepare('SELECT status FROM task_events WHERE task_id=1 ORDER BY id').all().map((e) => e.status);
  assert.deepEqual(evs, ['prep', 'doing']);
});

test('a task cannot be created straight into prep (same as doing/deploy) — 400', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks', payload: { project: 'demo', title: 'X', status: 'prep' } });
  assert.equal(r.statusCode, 400);
});
