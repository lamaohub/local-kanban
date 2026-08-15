import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = join(tmp, 'projects');
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'t','todo')").run(pid);

  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/horizons.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const call = (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
const codeOf = async (...a) => (await call(...a)).statusCode;

test('project fields keep their type, and a wrong one is a 400 with the field name', async () => {
  for (const body of [{ name: { a: 1 } }, { name: [1, 2] }, { pinned: null }, { archived: {} }, { description: [] }]) {
    const r = await call('PATCH', '/api/projects/demo', body);
    assert.equal(r.statusCode, 400, `${JSON.stringify(body)} answered ${r.statusCode}`);
    assert.match(r.json().error, new RegExp(Object.keys(body)[0]), 'the answer does not name the field');
  }
  assert.equal(db.prepare("SELECT name FROM projects WHERE slug='demo'").get().name, 'Demo');
});

test('project fields that are legitimately null or numeric still pass', async () => {
  assert.equal(await codeOf('PATCH', '/api/projects/demo', { description: null }), 200);
  assert.equal(await codeOf('PATCH', '/api/projects/demo', { pinned: 1 }), 200);
  assert.equal(await codeOf('PATCH', '/api/projects/demo', { pinned: true }), 200);
  assert.equal(db.prepare("SELECT pinned FROM projects WHERE slug='demo'").get().pinned, 1);
});

test('POST /api/projects with a non-string slug is a 400, not a crash in genPrefix', async () => {
  assert.equal(await codeOf('POST', '/api/projects', { slug: 5, name: 'x' }), 400);
  assert.equal(await codeOf('POST', '/api/projects', { slug: 'x', name: { a: 1 } }), 400);
});

test('a repeated query parameter is a 400, not a driver crash', async () => {
  assert.equal(await codeOf('GET', '/api/tasks?project=demo&project=other'), 400);
  assert.equal(await codeOf('GET', '/api/tasks?status=todo&status=done'), 400);
  assert.equal(await codeOf('GET', '/api/horizons?scale=days&scale=weeks'), 400);
  assert.equal(await codeOf('GET', '/api/tasks?project=demo'), 200);
  assert.equal(await codeOf('GET', '/api/horizons?scale=days'), 200);
});

test('a checklist item does not crash on text: null', async () => {
  const made = await call('POST', '/api/tasks/DM-1/checklist', { text: 'step' });
  assert.equal(made.statusCode, 201);
  const id = made.json().id;
  assert.equal(await codeOf('PATCH', `/api/tasks/DM-1/checklist/${id}`, { text: null }), 400);
  assert.equal(await codeOf('PATCH', `/api/tasks/DM-1/checklist/${id}`, { text: 'done' }), 200);
});

test('a horizon goal cannot point its parent_id at nothing', async () => {
  const made = await call('POST', '/api/horizons', { scale: 'days', period: '2026-08-15', text: 'g' });
  assert.equal(made.statusCode, 201);
  const id = made.json().id;
  assert.equal(await codeOf('POST', '/api/horizons', { scale: 'days', period: '2026-08-15', parent_id: 999999 }), 400);
  assert.equal(await codeOf('PATCH', `/api/horizons/${id}`, { parent_id: 999999 }), 400);
  assert.equal(await codeOf('PATCH', `/api/horizons/${id}`, { parent_id: id }), 400);
  assert.equal(await codeOf('PATCH', `/api/horizons/${id}`, { parent_id: null }), 200);
});

test('reorder and folder names refuse non-strings instead of crashing', async () => {
  assert.equal(await codeOf('POST', '/api/projects/reorder', { slugs: ['demo', 7] }), 400);
  assert.equal(await codeOf('POST', '/api/projects/reorder', { slugs: ['demo'] }), 200);
  assert.equal(await codeOf('POST', '/api/projects/folders', { name: { a: 1 } }), 400);
});
