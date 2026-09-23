// CLI is the only channel Claude has, and `kb show`/`kb take` printed everything about the task
// except the checklist — the owner wrote three items into a card with an empty description and
// Claude got a bare title. Both commands print the items now, as `- [ ]` / `- [x]` lines.
// The real binary `bin/kb` against the real task routes on a real socket: kb speaks HTTP, so
// `app.inject` cannot stand in for it, and a copy of the printing code would stay green while the
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
const ITEMS = ['Remove the rules block', 'Say property, not flat', 'No exact date, only percentages'];
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES (?,1,'Raffle section','Description line','todo')").run(pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES (?,2,'Plain task','- [ ] not a checklist, just text','todo')").run(pid);
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  // the items go in through the same route the drawer uses; the middle one gets ticked
  for (const text of ITEMS) await app.inject({ method: 'POST', url: '/api/tasks/DM-1/checklist', payload: { text } });
  const list = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1/checklist' })).json();
  await app.inject({ method: 'PATCH', url: `/api/tasks/DM-1/checklist/${list[1].id}`, payload: { done: true } });
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('kb show prints the checklist under the description, in order, with the done state', async () => {
  const r = await run(['show', 'DM-1']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const first = lines.indexOf(`- [ ] ${ITEMS[0]}`);
  assert.ok(first > 0, `the checklist is missing from kb show:\n${r.stdout}`);
  assert.equal(lines[first + 1], `- [x] ${ITEMS[1]}`, 'the ticked item is not marked as done');
  assert.equal(lines[first + 2], `- [ ] ${ITEMS[2]}`, 'the items are not in the board order');
  assert.ok(first > lines.indexOf('Description line'), 'the checklist comes after the description, like on the board');
});

test('kb take prints the checklist too — that is the copy Claude works from', async () => {
  const r = await run(['take', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^DM-1 prep /m, 'take did not pick the first todo task');
  assert.match(r.stdout, new RegExp(`^- \\[ \\] ${ITEMS[0]}$`, 'm'), `the checklist is missing from kb take:\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`^- \\[x\\] ${ITEMS[1]}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^- \\[ \\] ${ITEMS[2]}$`, 'm'));
});

test('a task without a checklist gets no checklist lines — only the description is printed', async () => {
  const r = await run(['show', 'DM-2']);
  assert.equal(r.code, 0, r.stderr);
  const boxes = r.stdout.split('\n').filter((l) => /^- \[[ x]\] /.test(l));
  assert.deepEqual(boxes, ['- [ ] not a checklist, just text'], 'lines that are not checklist items were printed as ones');
});

// empty and could not tell what was done. `kb check|uncheck <key> <n>` addresses the item by the
// number in which show/take print it.
const itemsOf = async (key) => (await app.inject({ method: 'GET', url: `/api/tasks/${key}/checklist` })).json();

test('kb check ticks the n-th item as printed, kb uncheck clears it', async () => {
  let r = await run(['check', 'DM-1', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `DM-1 - [x] ${ITEMS[0]} (1 open)`);
  r = await run(['uncheck', 'DM-1', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `DM-1 - [ ] ${ITEMS[1]} (2 open)`);
  assert.deepEqual((await itemsOf('DM-1')).map((c) => c.done), [true, false, false], 'the board did not get the ticks');
  r = await run(['show', 'DM-1']);
  assert.ok(r.stdout.split('\n').includes(`- [x] ${ITEMS[0]}`), 'kb show does not see the tick');
});

test('an item number that is not there is refused with code 2, nothing changes', async () => {
  const before = (await itemsOf('DM-1')).map((c) => c.done);
  for (const [args, text] of [
    [['check', 'DM-1', '4'], /only 3 checklist items/],
    [['check', 'DM-2', '1'], /no checklist/],
    [['check', 'DM-1', '0'], /kb check <key> <n>/],
    [['uncheck', 'DM-1', 'two'], /kb uncheck <key> <n>/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')} exited with ${r.code}`);
    assert.match(r.stderr, text);
  }
  assert.deepEqual((await itemsOf('DM-1')).map((c) => c.done), before);
});
