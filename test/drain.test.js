import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db, enqueue, drain, tasks = {};

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'test-owner';
  process.env.KB_GH_REPO = 'test-owner/test-repo';
  after(() => rmSync(tmp, { recursive: true, force: true }));

  ({ db, enqueue } = await import('../src/db.js'));
  const worker = await import('../src/sync/worker.js');
  drain = worker.drain;
  worker.ghState.available = true;
  worker.ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('a','A','A',10)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('b','B','B',10)").run();
  for (const [slug, no] of [['a', 1], ['b', 1]]) {
    const pid = db.prepare('SELECT id FROM projects WHERE slug=?').get(slug).id;
    db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,'T','todo')").run(pid, no);
    tasks[slug] = db.prepare('SELECT id FROM tasks WHERE project_id=?').get(pid).id;
  }
});

beforeEach(() => { db.exec('DELETE FROM sync_queue'); });

const rows = () => db.prepare('SELECT id, op, task_id, attempts FROM sync_queue ORDER BY id').all();

test('a failed create_issue does not stall the queue — other projects keep draining', async () => {
  enqueue('create_issue', tasks.a, { project: 'a' });
  enqueue('add_comment', tasks.a, { project: 'a' });
  enqueue('add_comment', tasks.b, { project: 'b' });

  const seen = [];
  await drain({
    handler: async (row) => {
      seen.push(`${row.op}:${row.task_id}`);
      if (row.op === 'create_issue') throw new Error('gh failed');
    },
  });

  assert.ok(seen.includes(`add_comment:${tasks.b}`), 'the op of another task was not processed — the queue stalled again');
  assert.ok(!seen.includes(`add_comment:${tasks.a}`), 'a dependent op must not run ahead of its create_issue');

  const left = rows();
  assert.ok(left.some((r) => r.op === 'create_issue'), 'the failed create_issue stays in the queue');
  assert.ok(left.some((r) => r.op === 'add_comment' && r.task_id === tasks.a), 'its dependent op stays too');
  assert.ok(!left.some((r) => r.task_id === tasks.b), 'a successful op of another task must leave the queue');
});

test('a successful op leaves the queue, a failed one accumulates attempts', async () => {
  enqueue('add_comment', tasks.a, { project: 'a' });
  enqueue('add_comment', tasks.b, { project: 'b' });
  await drain({ handler: async (row) => { if (row.task_id === tasks.a) throw new Error('transient'); } });

  const left = rows();
  assert.equal(left.length, 1, 'only the failed op should remain in the queue');
  assert.equal(left[0].task_id, tasks.a);
  assert.equal(left[0].attempts, 1, 'the attempt counter went up');
});

test('a permanent error is not retried — the op goes straight to failed (attempts = 15)', async () => {
  enqueue('add_comment', tasks.a, { project: 'a' });
  await drain({
    handler: async () => { const e = new Error('label not found'); e.permanent = true; throw e; },
  });
  assert.equal(rows()[0].attempts, 15, 'a permanent error is marked as out of attempts');
});

test('drain does not crash the process when a handler throws — the error stays contained', async () => {
  enqueue('add_comment', tasks.a, { project: 'a' });
  await assert.doesNotReject(() => drain({ handler: async () => { throw new Error('boom'); } }));
});

test('an op that succeeds on a retry resolves its own entries in the error log', async () => {
  db.exec('DELETE FROM app_errors');
  enqueue('close_issue', tasks.a, { project: 'a' });
  const opId = rows()[0].id;

  await drain({ handler: async () => { throw new Error('a transient GitHub failure'); } });
  const afterFail = db.prepare('SELECT id, op_id, resolved_at FROM app_errors').all();
  assert.equal(afterFail.length, 1, 'the failure was written to the log');
  assert.equal(afterFail[0].op_id, opId, 'the entry is linked to the op');
  assert.equal(afterFail[0].resolved_at, null, 'not resolved yet');

  db.prepare("UPDATE sync_queue SET next_attempt_at = datetime('now','-1 minute') WHERE id = ?").run(opId);
  await drain({ handler: async () => {} });
  assert.equal(rows().length, 0, 'the op left the queue');

  const afterOk = db.prepare('SELECT resolved_at FROM app_errors WHERE op_id = ?').all(opId);
  assert.equal(afterOk.length, 1, 'the entry is NOT deleted — the failure history is kept');
  assert.ok(afterOk[0].resolved_at, 'the entry is marked as resolved');
});

test('an op that never succeeded stays unresolved', async () => {
  db.exec('DELETE FROM app_errors');
  enqueue('close_issue', tasks.b, { project: 'b' });
  await drain({ handler: async () => { throw new Error('still failing'); } });
  const open = db.prepare('SELECT resolved_at FROM app_errors WHERE resolved_at IS NULL').all();
  assert.equal(open.length, 1, 'the entry stays unresolved — as it should, there is still something to fix');
});
