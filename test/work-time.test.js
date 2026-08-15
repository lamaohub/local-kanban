import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, CAP;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db, WORK_SEGMENT_MAX_S: CAP } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

let no = 0;
function working(status, agoSeconds) {
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const key = `DM-${++no}`;
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, work_started_at)
              VALUES (?,?,?,?, datetime('now', ?))`).run(pid, no, `t${no}`, status, `-${agoSeconds} seconds`);
  return key;
}
const row = (key) => db.prepare(`
  SELECT t.work_seconds, t.work_started_at, t.work_truncated FROM tasks t
  JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?`).get(key);
const patch = (key, payload) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload });

test('leaving a working status accumulates the elapsed time', async () => {
  const key = working('doing', 30);
  const r = await patch(key, { status: 'review' });
  assert.equal(r.statusCode, 200);
  const t = row(key);
  assert.equal(t.work_seconds >= 29 && t.work_seconds <= 40, true, `work_seconds = ${t.work_seconds}, expected about 30`);
  assert.equal(t.work_started_at, null);
  assert.equal(t.work_truncated, 0);
});

test('doing -> deploy does not stop the stopwatch', async () => {
  const key = working('doing', 30);
  await patch(key, { status: 'deploy' });
  const mid = row(key);
  assert.equal(mid.work_seconds, 0, 'the run was flushed on doing -> deploy: deploy is no longer a working status');
  assert.notEqual(mid.work_started_at, null, 'work_started_at was cleared on doing -> deploy');

  await patch(key, { status: 'review' });
  const end = row(key);
  assert.equal(end.work_seconds >= 29 && end.work_seconds <= 40, true, `work_seconds = ${end.work_seconds}, expected about 30`);
});

test('prep is not a working status: entering it stops the stopwatch', async () => {
  const key = working('doing', 30);
  await patch(key, { status: 'prep' });
  const t = row(key);
  assert.equal(t.work_seconds >= 29 && t.work_seconds <= 40, true, `work_seconds = ${t.work_seconds}`);
  assert.equal(t.work_started_at, null);
});

test('a forgotten task does not donate days to the weekly number', async () => {
  const key = working('doing', 3 * 24 * 3600);
  await patch(key, { status: 'review' });
  const t = row(key);
  assert.equal(t.work_seconds, CAP, `work_seconds = ${t.work_seconds}, expected the cap ${CAP}`);
  assert.equal(t.work_truncated, 1, 'the capped run was not counted, so the number looks exact');
});

test('the cap counter adds up over several runs', async () => {
  const key = working('doing', 3 * 24 * 3600);
  await patch(key, { status: 'review' });
  await patch(key, { status: 'doing' });
  db.prepare(`UPDATE tasks SET work_started_at = datetime('now','-2 days')
              WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
                          WHERE p.prefix || '-' || t.task_no = ?)`).run(key);
  await patch(key, { status: 'review' });
  const t = row(key);
  assert.equal(t.work_seconds, CAP * 2);
  assert.equal(t.work_truncated, 2);
});

test('work_truncated reaches the client, otherwise the mark cannot be drawn', async () => {
  const key = working('doing', 3 * 24 * 3600);
  await patch(key, { status: 'review' });
  const list = (await app.inject({ method: 'GET', url: '/api/tasks?all=1' })).json();
  const shown = list.find((t) => t.key === key);
  assert.equal(shown.work_truncated, 1);
  assert.equal(shown.work_seconds, CAP);
});
