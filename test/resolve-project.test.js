import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, resolveProject;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  const { db } = await import('../src/db.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('server-panel','SP','server-panel',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='server-panel'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Odd errors', 'todo')").run(pid);

  ({ resolveProject } = await import('../src/routes/projects.js'));
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(projectRoutes);
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('resolveProject: prefix (any case), slug, and misses', () => {
  assert.equal(resolveProject('SP')?.slug, 'server-panel');
  assert.equal(resolveProject('sp')?.slug, 'server-panel');           // prefix case does not matter
  assert.equal(resolveProject('server-panel')?.slug, 'server-panel');
  assert.equal(resolveProject('ZZ'), undefined);
  assert.ok(!resolveProject(''));
  assert.ok(!resolveProject(undefined));
});

test('GET /api/tasks?project=SP (kb take/ls SP) — 200, not 404', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=SP&status=todo' });
  assert.equal(r.statusCode, 200);
  const tasks = r.json();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].key, 'SP-1');
});

test('GET /api/tasks?project=sp — a lowercase prefix is 200 too', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=sp' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().length, 1);
});

test('GET /api/tasks?project=server-panel — slug still works', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=server-panel' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().length, 1);
});

test('GET /api/tasks?project=ZZ — an unknown project is still 404', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=ZZ' });
  assert.equal(r.statusCode, 404);
});

test('GET /api/projects/SP (kb info SP) — 200 by prefix', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/projects/SP' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().slug, 'server-panel');
});
