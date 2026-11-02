// Deploying past the column. The real routes and the real `bin/kb`.
// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base, n = 0;
const inject = (method, url, payload) => app.inject({ method, url, payload });
const task = (slug, status) => {
  const pid = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
  n += 1;
  db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, ?)').run(pid, n, 'Work', status);
  return `${slug === 'gated' ? 'GT' : 'DM'}-${n}`;
};
const move = (key, status) => inject('PATCH', `/api/tasks/${key}`, { status });
const gate = (on) => inject('PUT', '/api/flow', { ready_gate: on });
const kb = (args) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',900)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('gated','GT','Gated',900)").run();
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('off by default: a task goes to Deploying as before, and the board says the switch is off', async () => {
  assert.equal((await inject('GET', '/api/flow')).json().ready_gate, false);
  assert.equal((await move(task('demo', 'doing'), 'deploy')).statusCode, 200);
  const list = (await inject('GET', '/api/projects')).json();
  assert.equal(list.find((p) => p.slug === 'demo').ship_gate, false);
});

test('on: Deploying only through the column, from any status, with words that say what to do', async () => {
  await gate(true);
  for (const from of ['doing', 'prep', 'review']) {
    const key = task('demo', from);
    const r = await move(key, 'deploy');
    assert.equal(r.statusCode, 409, from);
    assert.equal(r.json().reason, 'ready-first');
    assert.match(r.json().error, new RegExp(`kb mv ${key} ready`));
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).status, from, 'moved all the same');
  }
  const key = task('demo', 'doing');
  assert.equal((await move(key, 'ready')).statusCode, 200);
  assert.equal((await move(key, 'deploy')).statusCode, 200);
  assert.equal((await move(key, 'deploy')).statusCode, 200, 'a second word in Deploying is no skipping');
  assert.equal((await move(key, 'review')).statusCode, 200);
  await gate(false);
});

test('on: Doing does not skip to Review, and what has nothing to ship still goes', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  const r = await move(key, 'review');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'ready-first');
  const refused = await kb(['review', key, 'all done']);
  assert.equal(refused.code, 2);
  const id = db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n, 0, 'a refused move left its note');
  assert.equal((await move(key, 'ready')).statusCode, 200);
  assert.equal((await move(key, 'review')).statusCode, 200, 'nothing to ship: from the column straight to Review');
  assert.equal((await move(task('demo', 'prep'), 'review')).statusCode, 200, 'a question answered in Prep has no code to ship');
  const check = task('demo', 'doing');
  await inject('PATCH', `/api/tasks/${check}`, { labels_add: ['check'] });
  assert.equal((await move(check, 'review')).statusCode, 200, 'the report of a check was held at the gate');
  await gate(false);
  assert.equal((await move(task('demo', 'doing'), 'review')).statusCode, 200, 'off, nothing is held');
});

test('words typed to a task in Review and undone put it back, gate or no gate', async () => {
  const { moveTyped } = await import('../src/routes/tasks.js');
  const sid = 'aaaaaaaa-1111-4222-8333-444444444444';
  const key = task('demo', 'review');
  const other = task('demo', 'todo');
  const row = (k) => db.prepare('SELECT * FROM tasks WHERE task_no = ?').get(Number(k.split('-')[1]));
  await gate(true);
  moveTyped(row(key), sid);
  assert.equal(row(key).status, 'doing');
  await app.inject({ method: 'PATCH', url: `/api/tasks/${other}`, payload: { status: 'prep' }, headers: { 'x-claude-session': sid } });
  assert.equal(row(key).status, 'review', 'the board left the task in Doing: undoing the words was refused');
  await gate(false);
});

test('kb says the refusal with code 2 and moves through ready by its short name', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  const r = await kb(['mv', key, 'deploy']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /goes to ready first/);
  assert.equal((await kb(['mv', key, 'ready'])).stdout.trim(), `${key} ready`);
  assert.equal((await kb(['mv', key, 'dp'])).code, 0);
  const info = await kb(['info', 'demo']);
  assert.match(info.stdout, /ships on the word/);
  await gate(false);
  assert.doesNotMatch((await kb(['info', 'demo'])).stdout, /ships on the word/);
});

test('a project has its own word over the board, both ways, and null gives it back', async () => {
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: 1 })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 409);
  assert.equal((await move(task('demo', 'doing'), 'deploy')).statusCode, 200, 'the word of one project held another');
  await gate(true);
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: 0 })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 200);
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: null })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 409);
  await gate(false);
  for (const v of [2, 'yes', true]) assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: v })).statusCode, 400);
});

test('a task done by hand does not wait: the person is the word', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  await inject('PATCH', `/api/tasks/${key}`, { labels_add: ['noclaude'] });
  assert.equal((await move(key, 'deploy')).statusCode, 200);
  await gate(false);
});

test('the column is not a way past work, the clock stops in it and goes on in Deploying', async () => {
  assert.equal((await move(task('demo', 'todo'), 'ready')).statusCode, 400);
  assert.equal((await move(task('demo', 'backlog'), 'ready')).statusCode, 400);
  const key = task('demo', 'doing');
  const row = () => db.prepare('SELECT status, work_started_at FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1]));
  db.prepare("UPDATE tasks SET work_started_at = datetime('now') WHERE task_no = ?").run(Number(key.split('-')[1]));
  await move(key, 'ready');
  assert.equal(row().work_started_at, null, 'the clock runs while the task waits for the word');
  await move(key, 'deploy');
  assert.ok(row().work_started_at, 'the clock does not start again for the shipping');
});

test('switched off with tasks in the column: they stay, and the board counts them', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  await move(key, 'ready');
  const r = await gate(false);
  assert.ok(r.json().ready_n >= 1);
  assert.equal(r.json().left_n, r.json().ready_n, 'the column would go without them');
  await inject('PATCH', '/api/projects/demo', { ready_gate: 1 });
  assert.equal((await inject('GET', '/api/flow')).json().left_n, 0, 'a project that waits keeps its column');
  await inject('PATCH', '/api/projects/demo', { ready_gate: null });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).status, 'ready');
  assert.equal((await inject('GET', '/api/projects')).json().find((p) => p.slug === 'demo').c_ready >= 1, true);
  assert.equal((await move(key, 'deploy')).statusCode, 200, 'a task left in the column cannot go on');
});

test('a task in the column stays a task of its session: Claude now and the sweep of terminals keep it', async () => {
  const { STAGE_PERCENT } = await import('../src/claude-now.js');
  assert.equal(STAGE_PERCENT.ready, 65);
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../src/phantom.js'), /const AT_WORK = new Set\(\[[^\]]*'ready'/, 'a Claude waiting for the word is closed as resting');
  assert.match(read('../src/claude-now.js'), /t\.status IN \('todo','ready','review','done'\)/, 'the task drops out of its run');
  assert.match(read('../public/js/sse.js'), /realTransition\(ev, 'review'\) \|\| realTransition\(ev, 'ready'\)\) playReviewSound/, 'nothing says a task waits for the word');
});

test('the switch takes only a yes or a no', async () => {
  assert.equal((await inject('PUT', '/api/flow', { ready_gate: 'on' })).statusCode, 400);
  assert.equal((await inject('PUT', '/api/flow', {})).statusCode, 400);
});
