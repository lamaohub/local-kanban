import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, enqueue;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = join(tmp, 'projects');
  process.env.KB_GH_OWNER = 'test-owner';
  process.env.KB_GH_REPO = 'test-owner/test-repo';
  process.env.KB_GH_BIN = join(tmp, 'no-gh');
  ({ db, enqueue } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('deleting the demo project closes the issues of its tasks and drops their pending ops', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/demo', payload: { lang: 'en' } })).statusCode, 201);
  const ids = db.prepare("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'demo' ORDER BY t.id").all().map((r) => r.id);
  assert.equal(ids.length, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0, 'the demo is created past the sync queue');
  // what the backfill does when the sync is switched on: two tasks got their issue, a third waits in the queue
  db.prepare('UPDATE tasks SET gh_issue_number = ? WHERE id = ?').run(101, ids[0]);
  db.prepare('UPDATE tasks SET gh_issue_number = ? WHERE id = ?').run(102, ids[4]);
  enqueue('create_issue', ids[2], { task_id: ids[2], key: 'DEMO-3' });

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/demo' })).statusCode, 200);
  const queue = db.prepare('SELECT task_id, op, payload FROM sync_queue ORDER BY id').all();
  assert.deepEqual(queue.filter((r) => r.task_id !== null), [], 'an op of a deleted task stayed in the queue');
  const closing = queue.filter((r) => r.op === 'delete_issue').map((r) => JSON.parse(r.payload).gh_issue_number).sort();
  assert.deepEqual(closing, [101, 102], 'the issues of the demo tasks stay open on GitHub');
  assert.equal(queue.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'demo'").get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id IN (${ids.join(',')})`).get().n, 0);
});
