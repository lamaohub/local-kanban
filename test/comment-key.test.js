// send of one comment carries one key; the server writes it once. Real routes, isolated database.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createUnsentComments, commentToken } from '../public/js/unsaved.js';

let app, tmp, db, bus;
const post = (payload, key = 'DM-1') => app.inject({ method: 'POST', url: `/api/tasks/${key}/comments`, payload });
const count = (id = 1) => db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  bus = (await import('../src/bus.js')).bus;
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (id, project_id, task_no, title, status) VALUES (1,?,1,'One','todo')").run(pid);
  db.prepare("INSERT INTO tasks (id, project_id, task_no, title, status) VALUES (2,?,2,'Two','todo')").run(pid);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('the second send of one key answers the same comment and writes nothing', async () => {
  const seen = [];
  const hear = (ev) => { if (ev?.type === 'task.comment') seen.push(ev); };
  bus.on('event', hear);
  const first = await post({ body: 'hello', client_key: 'k1' });
  const queued = db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op = 'add_comment'").get().n;
  const again = await post({ body: 'hello', client_key: 'k1' });
  bus.off('event', hear);
  assert.equal(first.statusCode, 201);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, first.json().id);
  assert.equal(count(), 1);
  assert.equal(seen.length, 1, 'a second event for the same comment');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op = 'add_comment'").get().n, queued, 'mirrored twice');
});

test('a key is the task\'s own, and a comment without one stays as it was', async () => {
  assert.equal((await post({ body: 'there', client_key: 'k1' }, 'DM-2')).statusCode, 201);
  const a = await post({ body: 'same words' });
  const b = await post({ body: 'same words' });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().id, b.json().id);
});

test('a key that is no key is refused by name', async () => {
  for (const client_key of [5, '', 'x'.repeat(65), {}]) {
    const r = await post({ body: 'x', client_key });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /client_key/);
  }
});

test('the queue keeps the key of the first send and gives a text of its own a key of its own', () => {
  const u = createUnsentComments();
  const c = u.add('DM-1', 'hello', 'first-send');
  assert.equal(u.get('DM-1', c.id).token, 'first-send');
  assert.equal(u.add('DM-1', 'hello', 'other').again, true);
  const d = u.add('DM-1', 'bye');
  assert.ok(d.token && d.token !== c.token);
  assert.notEqual(commentToken(), commentToken());
  assert.ok(commentToken().length <= 64);
});
