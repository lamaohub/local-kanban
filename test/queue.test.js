import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, enqueue, tid;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'test-owner';
  process.env.KB_GH_REPO = 'test-owner/test-repo';
  ({ db, enqueue } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, gh_issue_number, gh_item_id) VALUES (?,1,'T','todo',1,'IT')").run(pid);
  tid = db.prepare("SELECT id FROM tasks WHERE task_no=1").get().id;

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { db.exec('DELETE FROM sync_queue'); });

const queue = () => db.prepare('SELECT id, op, task_id, payload FROM sync_queue ORDER BY id').all();
const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/tasks/DM-1`, payload });

test('coalescing: a repeated set_priority collapses into the last one', () => {
  enqueue('set_priority', tid, { v: 1 });
  enqueue('set_priority', tid, { v: 2 });
  const rows = queue().filter((r) => r.op === 'set_priority');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).v, 2, 'the last snapshot is the one kept');
});

test('add_comment and create_issue are NOT coalesced', () => {
  enqueue('add_comment', tid, { n: 1 });
  enqueue('add_comment', tid, { n: 2 });
  enqueue('create_issue', tid, {});
  enqueue('create_issue', tid, {});
  assert.equal(queue().filter((r) => r.op === 'add_comment').length, 2);
  assert.equal(queue().filter((r) => r.op === 'create_issue').length, 2);
});

test('FIFO: ops are handed out strictly by ascending id', () => {
  enqueue('add_comment', tid, { n: 1 });
  enqueue('add_comment', tid, { n: 2 });
  enqueue('add_comment', tid, { n: 3 });
  const ns = queue().map((r) => JSON.parse(r.payload).n);
  assert.deepEqual(ns, [1, 2, 3]);
});

test('PATCH priority → enqueues set_priority', async () => {
  await patch({ priority: 2 });
  assert.ok(queue().some((r) => r.op === 'set_priority'));
});

test('PATCH labels → set_labels WITHOUT old_labels in the payload', async () => {
  await patch({ labels: ['bug', 'ui'] });
  const op = queue().find((r) => r.op === 'set_labels');
  assert.ok(op, 'set_labels was enqueued');
  const p = JSON.parse(op.payload);
  assert.deepEqual(p.labels, ['bug', 'ui']);
  assert.ok(!('old_labels' in p), 'old_labels is no longer needed — setLabels is declarative');
});

test('PATCH to a working status → set_status; finishing → close_issue', async () => {
  await patch({ status: 'doing' }); // todo → doing
  assert.ok(queue().some((r) => r.op === 'set_status'));
  db.exec('DELETE FROM sync_queue');
  await patch({ status: 'done' }); // doing → done
  assert.ok(queue().some((r) => r.op === 'close_issue'));
});

test('deleting a task clears its ops from the queue', async () => {
  const pid = db.prepare("SELECT project_id FROM tasks WHERE task_no=1").get().project_id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,2,'Tmp','todo')").run(pid);
  const tmpId = db.prepare("SELECT id FROM tasks WHERE task_no=2").get().id;
  enqueue('add_comment', tmpId, {});
  await app.inject({ method: 'DELETE', url: '/api/tasks/DM-2' });
  assert.equal(queue().filter((r) => r.task_id === tmpId).length, 0, 'the ops of a deleted task are cleared');
});
