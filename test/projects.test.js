import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, projectsRoot;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  projectsRoot = mkdtempSync(join(tmpdir(), 'kb-root-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = projectsRoot;
  await import('../src/db.js');
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  app = Fastify();
  await app.register(projectRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KB_LOCAL_ROOT;
  for (const d of [tmp, projectsRoot]) if (d) rmSync(d, { recursive: true, force: true });
});

const create = (payload) => app.inject({ method: 'POST', url: '/api/projects', payload });
const patch = (slug, payload) => app.inject({ method: 'PATCH', url: `/api/projects/${slug}`, payload });
const get = (slug) => app.inject({ method: 'GET', url: `/api/projects/${slug}` });

test('a project is created and its prefix is generated', async () => {
  const r = await create({ slug: 'my-cool-app', name: 'My application' });
  assert.equal(r.statusCode, 201);
  assert.match(r.json().prefix, /^[A-Z0-9]{2,10}$/, 'the prefix is uppercase');
});

test('slug and name are required, a duplicate slug is a 409', async () => {
  assert.equal((await create({ slug: 'no-name' })).statusCode, 400);
  assert.equal((await create({ name: 'no slug' })).statusCode, 400);
  assert.equal((await create({ slug: 'my-cool-app', name: 'duplicate' })).statusCode, 409);
});

test('prefixes are unique and case-insensitive', async () => {
  const first = (await create({ slug: 'alpha-beta', name: 'AB' })).json();
  const second = (await create({ slug: 'alpha-bravo', name: 'AB2' })).json();
  assert.notEqual(first.prefix, second.prefix, 'the generated prefixes differ');

  const clash = await patch('alpha-bravo', { prefix: first.prefix.toLowerCase() });
  assert.equal(clash.statusCode, 400);
  assert.match(clash.json().error, /taken/);
});

test('the prefix format is validated', async () => {
  assert.equal((await patch('alpha-beta', { prefix: 'x' })).statusCode, 400, 'too short');
  assert.equal((await patch('alpha-beta', { prefix: 'waytoolongprefix' })).statusCode, 400);
  assert.equal((await patch('alpha-beta', { prefix: 'ab' })).statusCode, 200, 'lowercase is normalised');
  assert.equal((await get('alpha-beta')).json().prefix, 'AB');
});

test('a project resolves by slug and by prefix', async () => {
  assert.equal((await get('alpha-beta')).statusCode, 200);
  assert.equal((await get('AB')).json().slug, 'alpha-beta', 'resolves by prefix');
  assert.equal((await get('ab')).json().slug, 'alpha-beta', 'prefix case does not matter');
  assert.equal((await get('no-such')).statusCode, 404);
});

test('categories are created, renamed and deleted', async () => {
  const cats = () => app.inject({ method: 'GET', url: '/api/categories' }).then((r) => r.json());
  await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Clients' } });
  assert.ok((await cats()).some((c) => c.name === 'Clients'), 'an empty category is visible before the first project');

  await patch('alpha-beta', { category: 'Clients' });
  await app.inject({ method: 'PATCH', url: '/api/categories/Clients', payload: { name: 'Customers' } });
  assert.equal((await get('alpha-beta')).json().category, 'Customers', 'the rename reached the projects');

  await app.inject({ method: 'DELETE', url: '/api/categories/Customers' });
  assert.equal((await get('alpha-beta')).json().category, null, 'the project moved to Other');
});

test('\'Other\' and \'Local\' are protected from renaming and deletion', async () => {
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/categories/Other', payload: { name: 'X' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/categories/Local' })).statusCode, 400);
});

test('an unregistered folder shows up in /folders and can be adopted', async () => {
  mkdirSync(join(projectsRoot, 'new-folder'));
  const before = (await app.inject({ method: 'GET', url: '/api/projects/folders' })).json();
  assert.equal(before.root, projectsRoot, 'the root is read from KB_LOCAL_ROOT at call time');
  assert.ok(before.unregistered.includes('new-folder'));

  const added = await app.inject({ method: 'POST', url: '/api/projects/folders', payload: { name: 'new-folder' } });
  assert.equal(added.statusCode, 201);
  const after = (await app.inject({ method: 'GET', url: '/api/projects/folders' })).json();
  assert.ok(!after.unregistered.includes('new-folder'), 'an adopted folder is no longer offered');
});

test('a folder is created even when the root does not exist yet', async () => {
  const missingRoot = join(projectsRoot, 'not-created-yet', 'nested');
  const saved = process.env.KB_LOCAL_ROOT;
  process.env.KB_LOCAL_ROOT = missingRoot;
  try {
    const r = await app.inject({ method: 'POST', url: '/api/projects/folders', payload: { name: 'first-folder' } });
    assert.equal(r.statusCode, 201, `an isolated instance cannot create its first folder: ${r.body}`);
    assert.equal(r.json().created, true);
  } finally { process.env.KB_LOCAL_ROOT = saved; }
});

test('folder name: slashes, a leading dot and non-latin characters are rejected', async () => {
  const bad = (name) => app.inject({ method: 'POST', url: '/api/projects/folders', payload: { name } });
  assert.equal((await bad('../escape')).statusCode, 400);
  assert.equal((await bad('.hidden')).statusCode, 400);
  assert.equal((await bad('папка')).statusCode, 400, 'non-latin characters are not allowed');
  assert.equal((await bad('')).statusCode, 400);
});

test('an archived project leaves the list but stays reachable by key', async () => {
  await patch('alpha-beta', { archived: 1 });
  const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json();
  assert.ok(!list.some((p) => p.slug === 'alpha-beta'), 'an archived project is not in the list');
  assert.equal((await get('alpha-beta')).statusCode, 200, 'but it still opens by key');
});

test('an archived project drops out of the task list, but stays reachable by name', async () => {
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'arch', name: 'Arch', prefix: 'ARC' } });
  await app.inject({ method: 'POST', url: '/api/tasks', payload: { project: 'arch', title: 'in the archive' } });

  const listed = () => app.inject({ method: 'GET', url: '/api/tasks?all=1' }).then((r) => r.json());
  assert.equal((await listed()).some((t) => t.project === 'arch'), true, 'the fixture stopped testing what it was written for');

  await app.inject({ method: 'PATCH', url: '/api/projects/arch', payload: { archived: 1 } });
  assert.equal((await listed()).some((t) => t.project === 'arch'), false, 'the archived project still shows up on "All projects"');

  const explicit = await app.inject({ method: 'GET', url: '/api/tasks?project=arch&all=1' });
  assert.equal(explicit.json().length, 1, 'an archived project can no longer be opened by name at all');

  const archived = await app.inject({ method: 'GET', url: '/api/projects/archived' });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().some((p) => p.slug === 'arch' && p.tasks_n === 1), true, 'there is no way to find what was archived');

  await app.inject({ method: 'PATCH', url: '/api/projects/arch', payload: { archived: 0 } });
  assert.equal((await listed()).some((t) => t.project === 'arch'), true, 'bringing a project back does not restore its tasks');
  await app.close();
});

test('pm2_services accepts both a JSON array and a comma-separated string', async () => {
  const { parsePm2Services, serializePm2Services } = await import('../src/pm2-services.js');
  assert.deepEqual(parsePm2Services('crm-tb'), ['crm-tb'], 'a bare string is one service');
  assert.deepEqual(parsePm2Services('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parsePm2Services('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parsePm2Services('[broken'), ['[broken'], 'broken JSON is not a crash');
  assert.deepEqual(parsePm2Services(null), []);
  assert.equal(serializePm2Services(''), null, 'an empty list clears the column');

  await create({ slug: 'pm2-proj', name: 'pm2 project', pm2_services: 'one, two' });
  assert.equal((await get('pm2-proj')).json().pm2_services, '["one","two"]',
    'the canonical JSON form is stored, whatever the caller sent');

  await patch('pm2-proj', { pm2_services: 'three' });
  assert.equal((await get('pm2-proj')).json().pm2_services, '["three"]');
  await patch('pm2-proj', { pm2_services: '' });
  assert.equal((await get('pm2-proj')).json().pm2_services, null, 'an empty value clears the field');
});
