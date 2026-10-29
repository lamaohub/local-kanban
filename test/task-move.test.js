// its id and everything hung on it, takes the next number of the project it goes to, and its old key stays an alias:
// notes, commits and the Claude that remembers it name it so. A task in work is not moved, nor a check into a project
// that has an open check. Its issue leaves the board of the old project for the new one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base;

const inject = (method, url, payload) => app.inject({ method, url, payload });
const add = async (project, title, status = 'todo', labels = []) => (await inject('POST', '/api/tasks', { project, title, status, labels })).json().key;
const moveTo = (key, project) => inject('POST', `/api/tasks/${key}/move`, { project });
const kb = (args) => new Promise((resolve) => {
  const env = { ...process.env, KB_URL: base };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_GH_OWNER: 'octocat', KB_GH_REPO: 'hello-world' });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  for (const [slug, prefix, archived] of [['shop', 'SH', 0], ['villa', 'VT', 0], ['old', 'OLD', 1]]) {
    db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, archived) VALUES (?,?,?,1,?)').run(slug, prefix, `${slug} board`, archived);
  }
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  for (const k of ['KB_GH_OWNER', 'KB_GH_REPO']) delete process.env[k];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('a moved task takes the next number of its new project, keeps what hangs on it, and its old key still leads to it', async () => {
  await add('villa', 'already there');
  const key = await add('shop', 'Move me');
  const other = await add('shop', 'a neighbour');
  assert.equal((await inject('POST', `/api/tasks/${key}/comments`, { author: 'me', body: 'a remark' })).statusCode, 201);
  assert.equal((await inject('POST', `/api/tasks/${key}/checklist`, { text: 'one step' })).statusCode, 201);
  assert.equal((await inject('POST', `/api/tasks/${key}/links`, { key: other })).statusCode, 200);
  const before = (await inject('GET', `/api/tasks/${key}`)).json();

  const r = await moveTo(key, 'villa');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().key, 'VT-2');
  assert.equal(r.json().old_key, key);
  assert.equal(r.json().project, 'villa');
  const t = (await inject('GET', '/api/tasks/VT-2')).json();
  assert.equal(t.id, before.id, 'the task was copied instead of moved');
  assert.equal(t.checklist.length, 1, 'the checklist stayed behind');
  assert.deepEqual(t.links.map((l) => l.key), [other], 'the link stayed behind');
  assert.equal((await inject('GET', '/api/tasks/VT-2/comments')).json()[0].body, 'a remark', 'the comments stayed behind');
  assert.deepEqual(t.moves.map((m) => m.key), [key], 'the card does not say where the task came from');
  // at the end of its new column, after the task that was there
  assert.ok(t.position > (await inject('GET', '/api/tasks/VT-1')).json().position);

  // the old key is an alias: the card, a move, kb
  assert.equal((await inject('GET', `/api/tasks/${key}`)).json().key, 'VT-2', 'the old key no longer leads to the task');
  assert.equal((await inject('PATCH', `/api/tasks/${key}`, { priority: 2 })).statusCode, 200);
  const shown = await kb(['show', key]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^VT-2 villa todo/);
  assert.match(shown.stdout, new RegExp(`^moved from: ${key}$`, 'm'), 'kb does not say where the task came from');
  // the number is not given again in the old project: the alias never meets a task of its own
  assert.equal(await add('shop', 'a new one'), 'SH-3');
  // the list of the old project no longer has it, the new one does
  assert.ok(!(await inject('GET', '/api/tasks?project=shop')).json().some((x) => x.id === before.id));
  assert.ok((await inject('GET', '/api/tasks?project=villa')).json().some((x) => x.key === 'VT-2'));
  // moved back, it takes a new number there too, and both old keys lead to it
  assert.equal((await moveTo('VT-2', 'SH')).json().key, 'SH-4');
  for (const k of [key, 'VT-2']) assert.equal((await inject('GET', `/api/tasks/${k}`)).json().key, 'SH-4');
  assert.deepEqual((await inject('GET', '/api/tasks/SH-4')).json().moves.map((m) => m.key), [key, 'VT-2']);
});

test('a task in work, the same project, an archived or unknown one, and a body without a project are refused', async () => {
  const key = await add('shop', 'in work');
  db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run((await inject('GET', `/api/tasks/${key}`)).json().id);
  let r = await moveTo(key, 'villa');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'in-work');
  // a manual task is the person's own — in any column
  const manual = await add('shop', 'by hand', 'todo', ['noclaude']);
  db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run((await inject('GET', `/api/tasks/${manual}`)).json().id);
  assert.equal((await moveTo(manual, 'villa')).statusCode, 200, 'a manual task in Doing was refused');
  const plain = await add('shop', 'plain');
  assert.equal((await moveTo(plain, 'shop')).statusCode, 400);
  assert.equal((await moveTo(plain, 'old')).statusCode, 400, 'an archived project took the task');
  assert.equal((await moveTo(plain, 'nowhere')).statusCode, 404);
  for (const body of [{}, { project: 5 }, { project: ['villa'] }, { project: '' }]) {
    assert.equal((await inject('POST', `/api/tasks/${plain}/move`, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await inject('POST', '/api/tasks/SH-999/move', { project: 'villa' })).statusCode, 404);
  assert.equal((await inject('GET', `/api/tasks/${plain}`)).json().key, plain, 'a refused move moved the task');
});

test('a check does not go into a project that has an open check', async () => {
  const open = await add('villa', 'Check the tasks in Review', 'todo', ['check']);
  const check = await add('shop', 'Check again', 'todo', ['check']);
  const r = await moveTo(check, 'villa');
  assert.equal(r.statusCode, 409);
  assert.deepEqual([r.json().reason, r.json().key], ['check-open', open]);
  // in Backlog it is no open check
  const parked = await add('shop', 'Check later', 'backlog', ['check']);
  assert.equal((await moveTo(parked, 'villa')).statusCode, 200);
});

test('its issue leaves the board of the old project for the new one and is named anew', async () => {
  const key = await add('shop', 'Synced');
  const id = (await inject('GET', `/api/tasks/${key}`)).json().id;
  db.prepare('UPDATE projects SET gh_project_number = 7 WHERE slug = ?').run('shop');
  db.prepare("UPDATE tasks SET gh_issue_number = 42, gh_issue_url = 'https://github.com/octocat/hello-world/issues/42', gh_item_id = 'PVTI_old' WHERE id = ?").run(id);
  db.prepare('DELETE FROM sync_queue').run();
  assert.equal((await moveTo(key, 'villa')).statusCode, 200);
  const ops = db.prepare('SELECT op, payload FROM sync_queue WHERE task_id = ? ORDER BY id').all(id);
  assert.deepEqual(ops.map((o) => o.op), ['remove_item', 'create_issue', 'update_issue']);
  assert.deepEqual(JSON.parse(ops[0].payload), { project_number: 7, item_id: 'PVTI_old' });
  assert.equal(db.prepare('SELECT gh_item_id FROM tasks WHERE id = ?').get(id).gh_item_id, null, 'the item of the old board stays the task\'s');

  // the worker: the old item is taken off, then the task is added to the board of its new project and set to its column
  const { processOp } = await import('../src/sync/worker.js');
  const calls = [];
  const api = {
    removeFromProject: async (p) => { calls.push(['remove', p.project_number, p.item_id]); },
    ensureProject: async (p) => { calls.push(['ensure', p.slug]); return p; },
    addToProject: async (p, url) => { calls.push(['add', p.slug, url]); return 'PVTI_new'; },
    setItemStatus: async (p, item, status) => { calls.push(['status', p.slug, item, status]); },
    updateIssue: async (data, p) => { calls.push(['update', p.slug, data.gh_issue_number]); },
    createIssueOnly: async () => { throw new Error('a second issue was made'); },
  };
  for (const row of db.prepare('SELECT * FROM sync_queue WHERE task_id = ? ORDER BY id').all(id)) await processOp(row, api);
  assert.deepEqual(calls, [
    ['remove', 7, 'PVTI_old'],
    ['ensure', 'villa'], ['add', 'villa', 'https://github.com/octocat/hello-world/issues/42'], ['status', 'villa', 'PVTI_new', 'todo'],
    ['update', 'villa', 42],
  ]);
  assert.equal(db.prepare('SELECT gh_item_id FROM tasks WHERE id = ?').get(id).gh_item_id, 'PVTI_new');
});

// out of it is an alias still: its number is not handed out again, or the old key would lead to the new task
test('a number moved out of a project with no counter is not handed out again, and the old key leads on in any case', async () => {
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('legacy', 'LG', 'legacy board', NULL)").run();
  await add('legacy', 'first');
  const top = await add('legacy', 'the last one');
  assert.equal(top, 'LG-2');
  db.prepare("UPDATE projects SET next_task_no = NULL WHERE slug = 'legacy'").run();
  const moved = (await moveTo(top, 'villa')).json().key;
  db.prepare("UPDATE projects SET next_task_no = NULL WHERE slug = 'legacy'").run();
  assert.equal(await add('legacy', 'a new one'), 'LG-3', 'the number of the moved task was handed out again');
  assert.equal((await inject('GET', '/api/tasks/LG-2')).json().key, moved);
  assert.equal((await inject('GET', '/api/tasks/lg-2')).json().key, moved, 'the old key in lower case leads nowhere');
});
