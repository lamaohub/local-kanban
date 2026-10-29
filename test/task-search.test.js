import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('search sees a description changed behind the board\'s back', async () => {
  assert.deepEqual(await search('незабудка'), []);
  db.prepare("UPDATE tasks SET description = 'теперь тут Незабудка' WHERE task_no = 2").run();
  assert.deepEqual(await search('незабудка'), ['DM-2'], 'the search answered from text that is no longer in the base');
});

test('search sees a rename through the board made in the same second and of the same length', async () => {
  assert.deepEqual(await search('ромашка'), []);
  const r = await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { title: 'ромашка!' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(await search('ромашка'), ['DM-4']);
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { title: 'лютик!!!' } });
  assert.deepEqual(await search('ромашка'), [], 'the old title is still found after a rename');
  assert.deepEqual(await search('лютик'), ['DM-4']);
});

test('search finds a task by the key of a renamed project', async () => {
  await search('dm-2'); // the text of the task is in memory now
  db.prepare("UPDATE projects SET prefix = 'ZQ' WHERE slug = 'demo'").run();
  try {
    assert.deepEqual(await search('zq-2'), ['ZQ-2'], 'the key is searched by the old prefix');
  } finally {
    db.prepare("UPDATE projects SET prefix = 'DM' WHERE slug = 'demo'").run();
  }
});

// the most recently changed first, as the search window orders them
test('a search asked with a limit answers with at most SEARCH_MAX tasks, the open and the newest first', async () => {
  const { SEARCH_MAX } = await import('../src/routes/tasks.js');
  assert.equal(SEARCH_MAX, 200);
  assert.match(readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8'), /limit=\$\{SEARCH_LIMIT\}/, 'the search window asks without the cap');
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status, labels, updated_at) VALUES (?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 260; i++) add.run(pid, 1000 + i, `много ${i}`, '', i < 100 ? 'done' : 'todo', '[]', `2026-10-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`);
  })();
  const whole = await app.inject({ method: 'GET', url: `/api/tasks?all=1&q=${encodeURIComponent('много')}` });
  assert.equal(whole.json().length, 260, 'the board\'s own search (no limit) hides tasks that are there');
  const more = await app.inject({ method: 'GET', url: `/api/tasks?all=1&limit=5000&q=${encodeURIComponent('много')}` });
  assert.equal(more.json().length, SEARCH_MAX, 'a limit over SEARCH_MAX lifts the cap');
  for (const bad of ['0', '-3', '2.5', 'x']) assert.equal((await app.inject({ method: 'GET', url: `/api/tasks?q=a&limit=${bad}` })).statusCode, 400, `limit=${bad}`);
  const r = await app.inject({ method: 'GET', url: `/api/tasks?all=1&limit=200&q=${encodeURIComponent('много')}` });
  const got = r.json();
  assert.equal(got.length, SEARCH_MAX);
  assert.equal(got.filter((t) => t.status === 'done').length, 40, 'closed tasks took the place of open ones');
  const done = got.filter((t) => t.status === 'done').map((t) => t.updated_at).sort();
  const all = db.prepare("SELECT updated_at FROM tasks WHERE title LIKE 'много %' AND status = 'done' ORDER BY updated_at DESC LIMIT 40").all().map((x) => x.updated_at).sort();
  assert.deepEqual(done, all, 'the closed tasks kept are not the most recently changed');
  db.prepare("DELETE FROM tasks WHERE title LIKE 'много %'").run();
});
