//  - When every card in To do was blocked, `kb take` answered a bare "empty": the human sees cards in
//    the column, Claude reported that there was nothing there.
//  - `kb take` printed the issue as a bare number and `kb show` as a bare link — two formats for one
//    thing, and the skill had to explain both.
// The real binary `bin/kb` against the real task routes on a real socket, like kb-checklist.test.js.
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
const URL42 = 'https://github.com/octocat/hello-world/issues/42';
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const project = (slug, prefix) => db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no) VALUES (?,?,?,5)')
    .run(slug, prefix, slug).lastInsertRowid;
  const add = db.prepare('INSERT INTO tasks (project_id, task_no, title, status, blocked, gh_issue_number, gh_issue_url, labels, pinned) VALUES (?,?,?,?,?,?,?,?,?)');
  const stuck = project('stuck', 'ST');
  add.run(stuck, 1, 'Waiting for the designer', 'todo', 1, null, null, '[]', 0);
  add.run(stuck, 2, 'Waiting for the API key', 'todo', 1, null, null, '[]', 0);
  project('quiet', 'QT');
  const synced = project('synced', 'SY');
  add.run(synced, 1, 'Synced task', 'todo', 0, 42, URL42, '[]', 0);
  const hand = project('hand', 'HD');
  add.run(hand, 1, 'Call the supplier', 'todo', 0, null, null, '["noclaude"]', 0);
  add.run(hand, 2, 'Sign the contract', 'todo', 1, null, null, '["noclaude"]', 1);
  add.run(hand, 3, 'Done already', 'done', 0, null, null, '["noclaude"]', 0);
  const mixed = project('mixed', 'MX');
  add.run(mixed, 1, 'Waiting for the designer', 'todo', 1, null, null, '[]', 0);
  add.run(mixed, 2, 'Call the supplier', 'todo', 0, null, null, '["noclaude"]', 0);
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('a To do where every card is blocked is not "empty" — take says how many are blocked', async () => {
  let r = await run(['take', 'stuck']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'empty (2 blocked)');
  r = await run(['next', 'stuck']);
  assert.equal(r.stdout.trim(), 'empty (2 blocked)');
  const statuses = db.prepare("SELECT status FROM tasks WHERE project_id = (SELECT id FROM projects WHERE slug = 'stuck')").all();
  assert.ok(statuses.every((t) => t.status === 'todo'), 'a blocked task was taken');
});

test('a To do left with cards done by hand is not "empty" — take and next name them', async () => {
  for (const cmd of ['take', 'next']) {
    let r = await run([cmd, 'hand']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'empty (2 by hand: HD-2 HD-1)', `${cmd}: the pinned card goes first, a done one is not counted`);
    r = await run([cmd, 'mixed']);
    assert.equal(r.stdout.trim(), 'empty (1 blocked, 1 by hand: MX-2)', `${cmd}: both numbers`);
  }
  const statuses = db.prepare("SELECT status FROM tasks WHERE project_id = (SELECT id FROM projects WHERE slug = 'hand') ORDER BY task_no").all();
  assert.deepEqual(statuses.map((t) => t.status), ['todo', 'todo', 'done'], 'a task done by hand was taken');
});

test('a really empty To do is still plain "empty"', async () => {
  const r = await run(['take', 'quiet']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'empty');
});

test('take and show print the issue the same way: number and link', async () => {
  const line = `issue: #42 ${URL42}`;
  const take = await run(['take', 'synced']);
  assert.equal(take.code, 0, take.stderr);
  assert.ok(take.stdout.split('\n').includes(line), `take:\n${take.stdout}`);
  const show = await run(['show', 'SY-1']);
  assert.ok(show.stdout.split('\n').includes(line), `show:\n${show.stdout}`);
});
