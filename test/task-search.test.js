import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;

const FILLER = 'ла-ла-ла '.repeat(26);
const DEEP = `${FILLER}ИгоЛка в стоге`;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const add = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, status, labels) VALUES (?,?,?,?,?,?)');
  add.run(pid, 1, 'стог сена', DEEP, 'backlog', '[]');
  add.run(pid, 2, 'просто задача', 'ничего интересного', 'todo', '[]');
  add.run(pid, 3, 'Иголка в заголовке', '', 'todo', '[]');
  add.run(pid, 4, 'помечена', '', 'todo', '["bug"]');

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const search = async (q) => {
  const r = await app.inject({ method: 'GET', url: `/api/tasks?all=1&q=${encodeURIComponent(q)}` });
  assert.equal(r.statusCode, 200);
  return r.json().map((t) => t.key).sort();
};

test('a word past the 180-char preview is still found', async () => {
  assert.equal(DEEP.indexOf('ИгоЛка') > 180, true, 'the fixture stopped testing what it was written for');
  assert.deepEqual(await search('в стоге'), ['DM-1']);
});

test('search is case-insensitive for non-ASCII too', async () => {
  assert.deepEqual(await search('иголка'), ['DM-1', 'DM-3']);
  assert.deepEqual(await search('ИГОЛКА'), ['DM-1', 'DM-3']);
});

test('search covers title, key and labels', async () => {
  assert.deepEqual(await search('просто'), ['DM-2']);
  assert.deepEqual(await search('dm-4'), ['DM-4']);
  assert.deepEqual(await search('bug'), ['DM-4']);
});

test('no match is an empty list, not an error', async () => {
  assert.deepEqual(await search('этого слова нигде нет'), []);
});

test('without q the list is not filtered', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?all=1' });
  assert.equal(r.json().length, 4);
});
