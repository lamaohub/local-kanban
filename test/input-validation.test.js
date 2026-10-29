import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-test-')));
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

const taskCount = () => db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

test('a task is created only for a project named by a string', async () => {
  const before = taskCount();
  for (const project of [true, [], {}, ['demo'], 5]) {
    const r = await call('POST', '/api/tasks', { project, title: 'x' });
    assert.equal(r.statusCode, 400, `project=${JSON.stringify(project)} answered ${r.statusCode}`);
    assert.match(r.json().error, /project/);
  }
  assert.equal(taskCount(), before, 'a one-element array was unwrapped and the task created anyway');
  assert.equal(await codeOf('POST', '/api/tasks', { project: 'demo', title: { a: 1 } }), 400);
  assert.equal(await codeOf('POST', '/api/tasks', { project: 'demo', description: ['x'] }), 400);
  assert.equal(await codeOf('POST', '/api/tasks', { project: 'demo', title: 'fine' }), 201);
});

test('the text fields of a task refuse objects, and a number stays the number that was sent', async () => {
  for (const body of [{ blocked: true, blocked_reason: {} }, { blocked: true, blocked_reason: true }, { blocked: true, blocked_reason: [] },
    { blocked: true, blocked_reason: ['a'] }, { title: { a: 1 } }, { description: [1] }]) {
    const r = await call('PATCH', '/api/tasks/DM-1', body);
    assert.equal(r.statusCode, 400, `${JSON.stringify(body)} answered ${r.statusCode}`);
  }
  const r = await call('PATCH', '/api/tasks/DM-1', { blocked: true, blocked_reason: 5 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().blocked_reason, '5', 'the driver stored the number 5 as "5.0"');
  assert.equal((await call('PATCH', '/api/tasks/DM-1', { blocked: false })).statusCode, 200);
  assert.equal(await codeOf('POST', '/api/tasks/DM-1/comments', { body: { a: 1 } }), 400, 'a comment was saved as "[object Object]"');
  assert.equal(await codeOf('POST', '/api/tasks/DM-1/checklist', { text: { a: 1 } }), 400);
});

test('a project keeps a name, and its prefix only changes to a string', async () => {
  for (const name of [null, '', '   ']) {
    const r = await call('PATCH', '/api/projects/demo', { name });
    assert.equal(r.statusCode, 400, `name=${JSON.stringify(name)} answered ${r.statusCode}`);
    assert.match(r.json().error, /name/);
  }
  assert.equal(db.prepare("SELECT name FROM projects WHERE slug='demo'").get().name, 'Demo');
  for (const prefix of [null, true, false, 12345, ['DM2']]) {
    const r = await call('PATCH', '/api/projects/demo', { prefix });
    assert.equal(r.statusCode, 400, `prefix=${JSON.stringify(prefix)} answered ${r.statusCode}`);
  }
  assert.equal(db.prepare("SELECT prefix FROM projects WHERE slug='demo'").get().prefix, 'DM', 'the keys of every task in the project were renamed');
  assert.equal(await codeOf('GET', '/api/tasks/DM-1'), 200);
  assert.equal(await codeOf('POST', '/api/projects', { slug: 'nullpref', name: 'n', prefix: null }), 400);
  assert.equal(await codeOf('PATCH', '/api/projects/demo', { prefix: 'dm' }), 200, 'a string prefix still works');
});

test('a slug is one path segment', async () => {
  for (const slug of ['../../esc', 'sl/ash', '.', '..', '.hidden', '-flag', 'a b', 'x'.repeat(101), 'имя']) {
    const r = await call('POST', '/api/projects', { slug, name: 'n' });
    assert.equal(r.statusCode, 400, `slug=${JSON.stringify(slug)} answered ${r.statusCode}`);
    assert.match(r.json().error, /slug/);
  }
  for (const slug of ['a', 'my.app_2', 'x'.repeat(100)]) assert.equal(await codeOf('POST', '/api/projects', { slug, name: 'n' }), 201, slug);
});

test('a snapshot of CLAUDE.md stays in backups/docs even for a slug made before the check', async () => {
  for (const [slug, prefix] of [['../../esc', 'ESC'], ['sl/ash', 'SLA']]) {
    const dir = join(tmp, `legacy-${prefix}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), 'old notes\n');
    db.prepare('INSERT INTO projects (slug, prefix, name, path) VALUES (?,?,?,?)').run(slug, prefix, prefix, dir);
    const url = `/api/projects/${encodeURIComponent(slug)}/docs/CLAUDE.md`;
    const doc = (await call('GET', url)).json();
    const r = await call('PUT', url, { text: 'new notes\n', confirm_path: doc.real_path });
    assert.equal(r.statusCode, 200, `${slug}: ${r.body}`);
    const backup = r.json().backup;
    assert.ok(backup.startsWith(join(tmp, 'backups', 'docs') + sep), `${slug}: the snapshot went to ${backup}`);
    assert.equal(readFileSync(backup, 'utf8'), 'old notes\n');
  }
});

test('a folder name is checked whole, and nothing is created before every check has passed', async () => {
  const root = join(tmp, 'projects');
  for (const name of ['a'.repeat(101), 'a'.repeat(300)]) {
    const r = await call('POST', '/api/projects/folders', { name });
    assert.equal(r.statusCode, 400, `${name.length} characters answered ${r.statusCode}`);
    assert.doesNotMatch(r.body, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the answer carries an absolute path');
  }
  db.prepare("INSERT INTO projects (slug, prefix, name, path) VALUES ('takenslug','TKN','Taken', '/elsewhere/takenslug')").run();
  const r = await call('POST', '/api/projects/folders', { name: 'takenslug' });
  assert.equal(r.statusCode, 409);
  assert.equal(existsSync(join(root, 'takenslug')), false, 'the folder was created although the answer was 409');
});

test('a folder that cannot be made is a 500 naming the error code, and its path goes only to the log', async () => {
  // The root of the project folders is a regular file: mkdir fails with ENOTDIR for anyone, root included.
  // The answer used to be "mkdir failed: <message>", and the message carries the absolute path.
  const blocker = join(tmp, 'folder-root-is-a-file');
  writeFileSync(blocker, '');
  const saved = process.env.KB_LOCAL_ROOT;
  process.env.KB_LOCAL_ROOT = blocker;
  try {
    db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('nofolder','NFD','No folder')").run();
    for (const [url, payload] of [['/api/projects/folders', { name: 'cannotmake' }], ['/api/projects/nofolder/folder', undefined]]) {
      const r = await call('POST', url, payload);
      assert.equal(r.statusCode, 500, `${url}: ${r.body}`);
      assert.match(r.json().error, /ENOTDIR/, `${url} does not say why the folder was not made`);
      assert.doesNotMatch(r.body, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${url}: the answer carries an absolute path`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = 'cannotmake'").get().n, 0, 'a project was registered without its folder');
    assert.equal(db.prepare("SELECT path FROM projects WHERE slug = 'nofolder'").get().path, null);
    const logged = db.prepare("SELECT detail FROM app_errors WHERE message LIKE 'mkdir failed%' ORDER BY id DESC LIMIT 2").all();
    assert.equal(logged.length, 2, 'the failed mkdir did not reach the error log');
    assert.ok(logged.every((e) => e.detail.startsWith(blocker)), 'the log lost the path the answer no longer carries');
  } finally { process.env.KB_LOCAL_ROOT = saved; }
});

test('a control character in the server path is a 400 before ssh is run', async () => {
  for (const url of ['/api/projects/ssh-check', '/api/projects/server-git']) {
    const r = await call('POST', url, { server: 'nohost.invalid', path: '/srv/a\u0000b' });
    assert.equal(r.statusCode, 400, `${url} answered ${r.statusCode}`);
    assert.match(r.json().error, /path/);
  }
});

test('a folder with a dot or an underscore in its name gets a prefix its task keys can use', async () => {
  for (const name of ['my.site', 'my_app']) {
    const r = await call('POST', '/api/projects/folders', { name });
    assert.equal(r.statusCode, 201, `${name}: ${r.body}`);
    assert.match(r.json().prefix, /^[A-Z0-9]{2,10}$/, `${name} got the prefix ${r.json().prefix}, and keys like ${r.json().prefix}-1 resolve to nothing`);
    const t = await call('POST', '/api/tasks', { project: name, title: 'first' });
    assert.equal(t.statusCode, 201);
    assert.equal(await codeOf('GET', `/api/tasks/${t.json().key}`), 200);
  }
});
