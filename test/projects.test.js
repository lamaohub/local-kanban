import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// `pm2 jlist` starts a daemon of its own when none runs: the board asks pm2 only when its pid file names a live process
test('the services of a project ask pm2 only when its daemon runs: no daemon, no pm2 started', async () => {
  const { pm2DaemonUp } = await import('../src/pm2-services.js');
  const home = mkdtempSync(join(tmpdir(), 'kb-pm2-'));
  const was = { PM2_HOME: process.env.PM2_HOME, KB_PANEL_URL: process.env.KB_PANEL_URL, PANEL_URL: process.env.PANEL_URL };
  try {
    assert.equal(pm2DaemonUp(home), false, 'no pid file');
    writeFileSync(join(home, 'pm2.pid'), `${process.pid}\n`);
    assert.equal(pm2DaemonUp(home), true, 'a live process');
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(home, 'pm2.pid'), String(gone));
    assert.equal(pm2DaemonUp(home), false, 'a pid file left by a daemon that is gone');
    writeFileSync(join(home, 'pm2.pid'), 'garbage');
    assert.equal(pm2DaemonUp(home), false);
    rmSync(join(home, 'pm2.pid'));
    Object.assign(process.env, { PM2_HOME: home, KB_PANEL_URL: '', PANEL_URL: '' });
    await create({ slug: 'pm2-none', name: 'no daemon', pm2_services: 'web' });
    const r = await app.inject({ method: 'GET', url: '/api/projects/pm2-none/status' });
    assert.equal(r.statusCode, 502);
    assert.match(r.json().error, /pm2 runs no daemon/);
    assert.deepEqual(readdirSync(home), [], 'pm2 was started and made its home');
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});

test('a project reports its docs and the skill it uses', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(projectsRoot, 'docs-proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# project notes\n');
  await create({ slug: 'docs-proj', name: 'docs project', path: dir, deploy_skill: 'deploy' });

  const body = (await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs' })).json();
  const claude = body.docs.find((d) => d.name === 'CLAUDE.md');
  assert.equal(claude.exists, true);
  assert.equal(claude.path, join(dir, 'CLAUDE.md'));
  assert.equal(body.docs.some((d) => d.name === 'README.md'), false, 'a file that is not there is not listed');
  assert.equal(body.skill.name, 'deploy');
  assert.equal(body.skill.generic, true, 'the generic deploy skill is marked as such');

  const doc = (await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs/CLAUDE.md' })).json();
  assert.equal(doc.text, '# project notes\n');
});

// name and folders. A guest gets the names, sizes and the text, and no path.
test("a guest reads the project docs without the owner's paths", async () => {
  const { homedir } = await import('node:os');
  const guest = { 'x-kb-guest': '1' };
  const list = await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs', headers: guest });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.docs.find((d) => d.name === 'CLAUDE.md').exists, true, 'what is there is still said');
  assert.equal(body.paths_hidden, true);
  assert.equal(body.skill.name, 'deploy');
  const doc = await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs/CLAUDE.md', headers: guest });
  assert.equal(doc.json().text, '# project notes\n');
  for (const r of [list, doc]) {
    assert.ok(!r.body.includes(projectsRoot), `a path of the project reached a guest: ${r.body}`);
    assert.ok(!r.body.includes(homedir()), `a path of the owner's home reached a guest: ${r.body}`);
  }
  // the owner still sees them
  const own = (await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs/CLAUDE.md' })).json();
  assert.ok(own.real_path && own.path.startsWith(projectsRoot));
  // the page of the project (renderDocs, public/js/project.js) draws the guest's answer: a file that is there, its path
  // not said, is not «not there»
  const drawn = await drawDocs(body);
  assert.match(drawn, /CLAUDE\.md/);
  assert.doesNotMatch(drawn, /not there/, 'a guest is told that a file the project has is not there');
  assert.match(await drawDocs({ ...body, paths_hidden: undefined, docs: body.docs.map((d) => ({ ...d, path: null })) }), /not there/,
    'the owner is no longer told a file has no path');
});

// renderDocs of public/js/project.js, read out of the file and run on stand-ins with an answer of the route
async function drawDocs(info) {
  const { default: vm } = await import('node:vm');
  const src = readFileSync(new URL('../public/js/project.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function renderDocs(');
  assert.ok(at >= 0, 'renderDocs is gone from project.js');
  const els = { 'ps-docs': { innerHTML: '', querySelectorAll: () => [] }, projset: { dataset: { slug: 'docs-proj' } } };
  const box = {
    $: (id) => els[id], api: async () => info, seg: (x) => x, ic: () => '', tr: (x) => x,
    esc: (x) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  };
  vm.createContext(box);
  vm.runInContext(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.renderDocs = renderDocs;`, box);
  await box.renderDocs({ slug: 'docs-proj', path: '/somewhere' });
  return els['ps-docs'].innerHTML;
}

test('CLAUDE.md is listed even when it is missing — that is a signal, not an empty answer', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = join(projectsRoot, 'nodocs-proj');
  mkdirSync(dir, { recursive: true });
  await create({ slug: 'nodocs-proj', name: 'no docs', path: dir });
  const body = (await app.inject({ method: 'GET', url: '/api/projects/nodocs-proj/docs' })).json();
  assert.deepEqual(body.docs.map((d) => d.name), ['CLAUDE.md']);
  assert.equal(body.docs[0].exists, false);
  assert.equal(body.skill, null, 'no deploy skill set — nothing is invented');
});

test('a document outside the fixed list cannot be read through the project path', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs/.env' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/docs-proj/docs/..%2f..%2fetc%2fpasswd' })).statusCode, 400);
});

test('a project document is written back only with the path the page confirmed', async () => {
  const { writeFileSync, readFileSync, mkdirSync, realpathSync, readdirSync } = await import('node:fs');
  const dir = realpathSync(projectsRoot) + '/edit-proj';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# before\n');
  await create({ slug: 'edit-proj', name: 'edit project', path: dir });
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/projects/edit-proj/docs/CLAUDE.md', payload });

  assert.equal((await put({ text: '# after\n' })).statusCode, 409, 'no confirmed path — no write');
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# before\n');

  const real = (await app.inject({ method: 'GET', url: '/api/projects/edit-proj/docs/CLAUDE.md' })).json().real_path;
  const ok = await put({ text: '# after\n', confirm_path: real });
  assert.equal(ok.statusCode, 200);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# after\n');
  assert.equal(readFileSync(ok.json().backup, 'utf8'), '# before\n', 'the previous text is kept');
  assert.ok(readdirSync(join(tmp, 'backups', 'docs')).some((f) => f.startsWith('edit-proj-CLAUDE.md-')));

  assert.equal((await app.inject({ method: 'PUT', url: '/api/projects/edit-proj/docs/.env', payload: { text: 'x', confirm_path: real } })).statusCode, 400);
});

// in Review, and the sidebar counted them anyway — it said 7 over a section of 4 tasks. The count of such reports comes
// with the project, and the sidebar takes it off.
test('the list of projects counts the reports of checks in Review apart', async () => {
  const { db } = await import('../src/db.js');
  const p = (await create({ slug: 'reports', name: 'Reports' })).json();
  const add = (no, status, labels) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, no, `t${no}`, status, JSON.stringify(labels));
  add(1, 'review', []); add(2, 'review', ['check']); add(3, 'review', ['check', 'ui']); add(4, 'doing', ['check']); add(5, 'review', ['checklist']);
  const row = (await app.inject({ method: 'GET', url: '/api/projects' })).json().find((x) => x.slug === 'reports');
  assert.deepEqual([row.c_review, row.c_review_check], [4, 2], 'a report in Review is not told apart, or another label is taken for one');
  const sidebar = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
  assert.match(sidebar, /const inReview = state\.projects\.reduce\(\(s, p\) => s \+ \(p\.c_review \|\| 0\) - \(p\.c_review_check \|\| 0\), 0\);/,
    'the sidebar counts the reports of checks in its «Claude review»');
});
