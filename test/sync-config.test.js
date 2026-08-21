import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, enqueue, kvSet, syncConfigured, tid;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  delete process.env.KB_GH_OWNER;
  delete process.env.KB_GH_REPO;
  ({ db, enqueue, kvSet, syncConfigured } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('demo','DM','Demo')").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'T','todo')").run(pid);
  tid = db.prepare('SELECT id FROM tasks WHERE task_no=1').get().id;

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const systemRoutes = (await import('../src/routes/system.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.register(systemRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const queue = () => db.prepare('SELECT * FROM sync_queue').all();

test('without config: syncConfigured=false and enqueue is a no-op', () => {
  assert.equal(syncConfigured(), false);
  enqueue('add_comment', tid, { n: 1 });
  assert.equal(queue().length, 0, 'the queue does not grow in local-only mode');
});

test('GET /api/sync answers configured:false without owner/repo', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sync' });
  const s = res.json();
  assert.equal(s.configured, false);
  assert.equal(s.source, null);
});

test('POST /api/sync/config turns the sync on through kv and enqueue comes alive', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/sync/config', payload: { owner: 'x', repo: 'no-slash' } });
  assert.equal(bad.statusCode, 400, 'a repo not shaped owner/name is rejected');

  const res = await app.inject({ method: 'POST', url: '/api/sync/config', payload: { owner: 'someone', repo: 'someone/board' } });
  assert.equal(res.json().configured, true);
  assert.equal(syncConfigured(), true);
  const before = queue().filter((r) => r.op === 'add_comment').length;
  enqueue('add_comment', tid, { n: 1 });
  assert.equal(queue().filter((r) => r.op === 'add_comment').length, before + 1, 'with a config the queue works again');

  db.exec('DELETE FROM sync_queue');
  await app.inject({ method: 'POST', url: '/api/sync/config', payload: { owner: '', repo: '' } });
  assert.equal(syncConfigured(), false);
});

test('the validator rejects a leading hyphen and dot segments', async () => {
  const post = (payload) => app.inject({ method: 'POST', url: '/api/sync/config', payload });

  assert.equal((await post({ owner: '-X' })).statusCode, 400, 'an owner with a leading hyphen');
  assert.equal((await post({ repo: '../..' })).statusCode, 400, 'a repo made of dot segments');
  assert.equal((await post({ repo: '-a/b' })).statusCode, 400, 'a repo segment with a leading hyphen');
  assert.equal((await post({ repo: 'a/b/c' })).statusCode, 400, 'an extra segment in repo');

  const ok = await post({ owner: 'octocat', repo: 'octocat/hello-world' });
  assert.equal(ok.statusCode, 200, 'normal values still pass');

  await post({ owner: '', repo: '' });
  assert.equal(syncConfigured(), false);
});

test('turning the sync on later backfills create_issue for existing tasks', async () => {
  db.exec('DELETE FROM sync_queue');
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,2,'open','backlog')").run(pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,3,'closed','done')").run(pid);
  assert.equal(syncConfigured(), false, 'precondition: sync is off and tasks already exist');

  const res = await app.inject({ method: 'POST', url: '/api/sync/config', payload: { owner: 'someone', repo: 'someone/board' } });
  const created = db.prepare("SELECT task_id FROM sync_queue WHERE op='create_issue'").all();
  assert.equal(res.json().backfilled, created.length);
  assert.ok(created.length >= 2, 'both live tasks (tid from before plus the new one) got a create_issue');

  const closedId = db.prepare('SELECT id FROM tasks WHERE task_no = 3').get().id;
  assert.ok(!created.some((r) => r.task_id === closedId), 'a done task is not backfilled');

  await app.inject({ method: 'POST', url: '/api/sync/config', payload: { owner: '', repo: '' } });
  db.exec('DELETE FROM sync_queue');
  db.exec('DELETE FROM tasks WHERE task_no IN (2,3)');
});

test('posting the same config again does not backfill create_issue twice', async () => {
  db.exec('DELETE FROM sync_queue');
  const post = (payload) => app.inject({ method: 'POST', url: '/api/sync/config', payload });
  await post({ owner: 'someone', repo: 'someone/board' });
  const first = db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op='create_issue'").get().n;
  const again = await post({ owner: 'someone', repo: 'someone/board' });
  assert.equal(again.json().backfilled, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op='create_issue'").get().n, first);

  await post({ owner: '', repo: '' });
  db.exec('DELETE FROM sync_queue');
});
