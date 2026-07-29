import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Task','todo')").run(pid);
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const up = (mime) => app.inject({ method: 'POST', url: '/api/tasks/DM-1/attachments', headers: { 'content-type': mime }, payload: PNG });

test('uploading an image → 201, file on disk, url served', async () => {
  const r = await up('image/png');
  assert.equal(r.statusCode, 201);
  const a = r.json();
  assert.match(a.url, /^\/attachments\/1\/\d+\.png$/);
  assert.ok(existsSync(join(tmp, 'attachments', '1', `${a.id}.png`)), 'the file is written');
});

test('a non-image is rejected (400)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-1/attachments', headers: { 'content-type': 'text/plain' }, payload: 'hi' });
  assert.equal(r.statusCode, 400);
});

test('the task list and the task details both carry the attachment', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/DM-1/attachments' })).json().length, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/DM-1' })).json().attachments.length, 1);
});

test('DELETE removes the attachment and the file', async () => {
  const a = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1/attachments' })).json()[0];
  const r = await app.inject({ method: 'DELETE', url: `/api/tasks/DM-1/attachments/${a.id}` });
  assert.equal(r.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/DM-1/attachments' })).json().length, 0);
  assert.ok(!existsSync(join(tmp, 'attachments', '1', a.file)), 'the file is gone');
});

test('deleting a task clears its attachment folder and rows (cascade)', async () => {
  await up('image/png');
  assert.ok(existsSync(join(tmp, 'attachments', '1')), 'the folder exists before the delete');
  await app.inject({ method: 'DELETE', url: '/api/tasks/DM-1' });
  assert.ok(!existsSync(join(tmp, 'attachments', '1')), 'the folder is removed with the task');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_attachments').get().n, 0, 'the rows went with the cascade');
});
