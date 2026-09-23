// says "related tasks solved together are taken together" — and Claude could not follow it, because
// neither `kb show` nor `kb take` printed a single link. Nor could a sub-task be made from the CLI:
// `kb link` sent only the key, while the route has always accepted `rel`.
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
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',5)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const add = db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,?)');
  add.run(pid, 1, 'Checkout page', 'todo');
  add.run(pid, 2, 'Payment form', 'backlog');
  add.run(pid, 3, 'Receipt email', 'backlog');
  add.run(pid, 4, 'Cart badge', 'backlog');
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

test('kb link <a> <b> child makes b a sub-task of a; without a word the link stays related', async () => {
  let r = await run(['link', 'DM-1', 'DM-2', 'child']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-1 ↓DM-2');
  r = await run(['link', 'DM-1', 'DM-3']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-1 ↓DM-2 ↔DM-3');
  r = await run(['link', 'DM-4', 'DM-1', 'parent']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-4 ↑DM-1', 'parent: the second task becomes the parent of the first');
});

test('an unknown link type is refused before anything is written', async () => {
  const r = await run(['link', 'DM-2', 'DM-3', 'sibling']);
  assert.equal(r.code, 2, 'a usage error exits with 2');
  const links = (await app.inject({ method: 'GET', url: '/api/tasks/DM-2' })).json().links;
  assert.deepEqual(links.map((l) => l.key), ['DM-1'], 'the refused link was created anyway');
});

test('kb show prints every link with its direction, title and status', async () => {
  let r = await run(['show', 'DM-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^↓ subtask DM-2 Payment form \(backlog\)$/m, `the sub-task is missing:\n${r.stdout}`);
  assert.match(r.stdout, /^↓ subtask DM-4 Cart badge \(backlog\)$/m);
  assert.match(r.stdout, /^↔ related DM-3 Receipt email \(backlog\)$/m);
  r = await run(['show', 'DM-2']);
  assert.match(r.stdout, /^↑ parent DM-1 Checkout page \(todo\)$/m, `the parent is missing:\n${r.stdout}`);
});

test('kb take prints the links too', async () => {
  const r = await run(['take', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^DM-1 prep /m);
  assert.match(r.stdout, /^↓ subtask DM-2 Payment form \(backlog\)$/m, `take printed no links:\n${r.stdout}`);
  assert.match(r.stdout, /^↔ related DM-3 Receipt email \(backlog\)$/m);
});

test('kb unlink removes a sub-task link and prints what is left', async () => {
  const r = await run(['unlink', 'DM-1', 'DM-2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-1 ↓DM-4 ↔DM-3');
});
