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
  ({ db } = await import('../src/db.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',1)").run();

  const projectRoutes = (await import('../src/routes/projects.js')).default;
  app = Fastify();
  await app.register(projectRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const patch = (deploy_skill) =>
  app.inject({ method: 'PATCH', url: '/api/projects/demo', payload: { deploy_skill } });
const get = () => app.inject({ method: 'GET', url: '/api/projects/demo' });

test('PATCH with traversal in deploy_skill is rejected (400)', async () => {
  const r = await patch('../../../../private/tmp/evil');
  assert.equal(r.statusCode, 400);
});

test('a slash in the skill name is rejected (400)', async () => {
  assert.equal((await patch('deploy/../../etc')).statusCode, 400);
  assert.equal((await patch('a/b')).statusCode, 400);
});

test('a legacy value from the database does not resolve to a path (deploy_skill_path = null)', async () => {
  db.prepare("UPDATE projects SET deploy_skill='../../../../private/tmp/evil' WHERE slug='demo'").run();
  const body = (await get()).json();
  assert.equal(body.deploy_skill, '../../../../private/tmp/evil');
  assert.equal(body.deploy_skill_path, null);
});

test('a plain skill name is accepted', async () => {
  assert.equal((await patch('deploy')).statusCode, 200);
  assert.equal((await patch('deploy-tickets')).statusCode, 200);
  assert.equal((await get()).json().deploy_skill, 'deploy-tickets');
});

test('an empty string is allowed — it clears the field', async () => {
  assert.equal((await patch('')).statusCode, 200);
  assert.equal((await get()).json().deploy_skill_path, null);
});
