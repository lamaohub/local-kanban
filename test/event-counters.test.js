import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, heard;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','EV','demo',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const no of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'todo')").run(pid, no, `Task ${no}`);
  const { bus } = await import('../src/bus.js');
  heard = [];
  bus.on('event', (e) => heard.push(e));
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const last = (type) => heard.filter((e) => e.type === type).at(-1)?.data;
const listed = async (key) => (await app.inject({ method: 'GET', url: '/api/tasks?project=demo&all=1' })).json().find((t) => t.key === key);

test('a note and its removal carry the number of comments of the card', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/EV-1/comments', payload: { body: 'first', author: 'claude' } });
  assert.equal(r.statusCode, 201);
  assert.equal(last('task.comment').comments_n, 1);
  await app.inject({ method: 'POST', url: '/api/tasks/EV-1/comments', payload: { body: 'second' } });
  assert.equal(last('task.comment').comments_n, 2);
  await app.inject({ method: 'DELETE', url: `/api/tasks/EV-1/comments/${r.json().id}` });
  assert.equal(last('task.comment').comments_n, 1, 'a removed comment does not say how many are left');
  assert.equal((await listed('EV-1')).comments_n, 1);
});

test('an attachment and its removal carry the number of attachments', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/EV-1/attachments', headers: { 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 201);
  assert.equal(last('task.attached').attachments_n, 1);
  await app.inject({ method: 'DELETE', url: `/api/tasks/EV-1/attachments/${r.json().id}` });
  assert.equal(last('task.attached').attachments_n, 0);
});

test('a link and an unlink carry the links of BOTH tasks, the same as the list gives', async () => {
  await app.inject({ method: 'POST', url: '/api/tasks/EV-1/links', payload: { key: 'EV-2' } });
  const ev = last('task.linked');
  const [one, two] = [await listed('EV-1'), await listed('EV-2')];
  assert.deepEqual(ev.linked, { [one.id]: one.linked_ids, [two.id]: two.linked_ids });
  assert.deepEqual(one.linked_ids, [two.id]);
  await app.inject({ method: 'DELETE', url: `/api/tasks/EV-1/links/${two.id}` });
  assert.deepEqual(last('task.linked').linked, { [one.id]: [], [two.id]: [] });
});

test('a change of a task keeps its counters in the event', async () => {
  await app.inject({ method: 'POST', url: '/api/tasks/EV-1/attachments', headers: { 'content-type': 'image/png' }, payload: PNG });
  const r = await app.inject({ method: 'PATCH', url: '/api/tasks/EV-1', payload: { priority: 2 } });
  assert.equal(r.statusCode, 200);
  const ev = last('task.updated');
  assert.equal(ev.key, 'EV-1');
  assert.equal(ev.comments_n, 1, 'after a change the card would lose its comment badge');
  assert.equal(ev.attachments_n, 1, 'after a change the card would lose its attachment badge');
  assert.equal(ev.prev_status, 'todo');
});
