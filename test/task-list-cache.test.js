// compressed it again on the main thread (5.6–8.4 s an answer under load). The answer — and its compressed copies — is
// kept per request until an event that can change the list, never past LIST_TTL_MS. And «New task» asks for only the
// newest tasks it shows (`newest=N`) instead of the whole board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import Fastify from 'fastify';

let app, tmp, db, emit, pid;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-list-cache-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ emit } = await import('../src/bus.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('lc','LC','List cache',100)").run();
  pid = db.prepare("SELECT id FROM projects WHERE slug='lc'").get().id;
  const add = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, status) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 40; i++) add.run(pid, i, `task ${i}`, 'x'.repeat(200), i % 3 ? 'done' : 'todo');
  const { compressAnswer } = await import('../src/compress.js');
  app = Fastify();
  app.addHook('onSend', compressAnswer); // as server.js has it on the root instance
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const list = async (url, headers = {}) => {
  const r = await app.inject({ method: 'GET', url, headers });
  assert.equal(r.statusCode, 200, r.body);
  return r;
};

test('a list read again is the same answer; a change of a task — through the routes or by an event — is seen at once', async () => {
  const a = (await list('/api/tasks?project=lc&all=1')).json();
  assert.equal(a.length, 40);
  // written past the routes: kept until an event says the tasks changed
  db.prepare("UPDATE tasks SET title = 'renamed' WHERE project_id = ? AND task_no = 1").run(pid);
  assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-1').title, 'task 1', 'not kept');
  emit('task.work', { ids: [] }); // Claude's transcript grew: the list is the same
  assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-1').title, 'task 1');
  emit('task.updated', { id: 1 });
  assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-1').title, 'renamed');
  const r = await app.inject({ method: 'PATCH', url: '/api/tasks/LC-2', payload: { title: 'through the route' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-2').title, 'through the route');
  // another request is another answer
  assert.ok((await list('/api/tasks?project=lc')).json().every((t) => t.status === 'todo'));
});

test('the kept answer goes compressed the way the browser takes it, and reads the same', async () => {
  const plain = (await list('/api/tasks?project=lc&all=1')).body;
  for (const [enc, unpack] of [['br', zlib.brotliDecompressSync], ['gzip', zlib.gunzipSync]]) {
    for (let i = 0; i < 2; i++) { // built, then kept
      const r = await list('/api/tasks?project=lc&all=1', { 'accept-encoding': enc });
      assert.equal(r.headers['content-encoding'], enc);
      assert.match(String(r.headers.vary), /accept-encoding/i);
      assert.match(String(r.headers['content-type']), /application\/json/);
      assert.equal(unpack(r.rawPayload).toString(), plain);
    }
  }
});

test('a search is never answered from what is kept', async () => {
  await list('/api/tasks?project=lc&all=1&q=task');
  db.prepare("UPDATE tasks SET title = 'needle', updated_at = datetime('now', '+1 minute') WHERE project_id = ? AND task_no = 4").run(pid);
  assert.deepEqual((await list('/api/tasks?project=lc&all=1&q=needle')).json().map((t) => t.key), ['LC-4']);
});

test('newest=N gives the N most recently created tasks of any status, and nothing else', async () => {
  const got = (await list('/api/tasks?all=1&newest=5')).json();
  assert.deepEqual(got.map((t) => t.key), ['LC-40', 'LC-39', 'LC-38', 'LC-37', 'LC-36']);
  for (const bad of ['0', '101', 'x', '2.5']) {
    assert.equal((await app.inject({ method: 'GET', url: `/api/tasks?newest=${bad}` })).statusCode, 400, bad);
  }
  // «New task» asks for them, not for the whole board
  const chaos = readFileSync(new URL('../public/js/chaos.js', import.meta.url), 'utf8');
  assert.match(chaos, /\/api\/tasks\?all=1&newest=\$\{RECENT_N\}/);
});

// on a quiet board; and a change event made quiet by mistake, or a key without one of its parts, stayed green
test('at most LIST_KEEP answers are kept, the one asked last stays', async () => {
  const { LIST_KEEP, listCacheSize } = await import('../src/routes/tasks.js');
  emit('task.updated', { id: 1 });
  await list('/api/tasks?project=lc&all=1');
  for (let n = 1; n <= 60; n++) {
    await list(`/api/tasks?all=1&newest=${n}`);
    if (n % 10 === 0) await list('/api/tasks?project=lc&all=1'); // asked again now and then: the most recent
  }
  assert.ok(listCacheSize() <= LIST_KEEP, `${listCacheSize()} answers kept`);
  db.prepare("UPDATE tasks SET title = 'past the routes' WHERE project_id = ? AND task_no = 3").run(pid);
  assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-3').title, 'task 3', 'the one asked last was dropped');
  emit('task.updated', { id: 3 });
});

test('each event that changes what the list shows clears it; each part of the request is a part of the key', async () => {
  for (const type of ['task.updated', 'task.comment', 'task.attached', 'task.linked', 'task.deleted', 'task.created', 'task.moved', 'tasks.imported', 'project.updated']) {
    await list('/api/tasks?project=lc&all=1');
    db.prepare('UPDATE tasks SET title = ? WHERE project_id = ? AND task_no = 4').run(type, pid);
    emit(type, { id: 4 });
    assert.equal((await list('/api/tasks?project=lc&all=1')).json().find((t) => t.key === 'LC-4').title, type, `${type} left the list as it was`);
  }
  const all = (await list('/api/tasks?all=1')).json().length;
  assert.equal((await list('/api/tasks?all=1&newest=15')).json().length, 15, 'newest is not a part of the key');
  assert.equal((await list('/api/tasks?all=1')).json().length, all, 'newest is not a part of the key');
  assert.ok((await list('/api/tasks?project=lc&status=done')).json().every((t) => t.status === 'done'));
  assert.ok((await list('/api/tasks?project=lc')).json().every((t) => t.status === 'todo'), 'status is not a part of the key');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('lc2','LD','Other',2)").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug='lc2'), 1, 'other', 'todo')").run();
  emit('project.updated', {});
  await list('/api/tasks?project=lc&all=1');
  assert.deepEqual((await list('/api/tasks?project=lc2&all=1')).json().map((t) => t.key), ['LD-1'], 'project is not a part of the key');
});
