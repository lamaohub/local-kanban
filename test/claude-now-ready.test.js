// ship, their session was cut off («session interrupted» on the cards), and the run was neither in «Claude now» nor in
// «Claude done». It is no task in work all the same: the count of the sidebar does not take it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SR = '55555555-5555-4555-8555-555555555555'; // a run that handed its tasks in to Ready to ship, its Claude gone since
let app, tmp, claude, now;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  now = await import('../src/claude-now.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('tix','TX','Tickets',4)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'tix'").get().id;
  for (const no of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const move = async (key, status) => {
  const r = await app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': SR }, payload: { status } });
  assert.equal(r.statusCode, 200, r.body);
};
const nobodyAlive = () => false;

test('a run of tasks in Ready to ship stays in «Claude now» when its Claude is gone, and not in «Claude done»', async () => {
  for (const k of ['TX-1', 'TX-2', 'TX-3']) await move(k, 'prep');
  for (const k of ['TX-1', 'TX-2', 'TX-3']) await move(k, 'doing');
  await move('TX-1', 'ready');
  await move('TX-2', 'ready');
  await move('TX-3', 'review');
  const d = await now.nowRuns(nobodyAlive);
  const run = d.runs.find((r) => r.session === SR);
  assert.ok(run, 'the run waiting for the word to ship is gone from «Claude now»');
  assert.equal(run.claude, 'gone');
  assert.deepEqual(run.tasks.map((t) => [t.key, t.status]).sort(), [['TX-1', 'ready'], ['TX-2', 'ready'], ['TX-3', 'review']]);
  assert.equal(d.tasks_n, 0, 'a task in Ready to ship counted as one in work: the sidebar sums only those');
  assert.equal(now.doneRuns().runs.some((r) => r.session === SR), false, 'one run in both sections');
});

test('shipped and handed in to Review, the run is done: it leaves «Claude now» for «Claude done»', async () => {
  await move('TX-1', 'review');
  await move('TX-2', 'review');
  assert.equal((await now.nowRuns(nobodyAlive)).runs.some((r) => r.session === SR), false, 'a finished run stays in «Claude now»');
  const done = now.doneRuns().runs.find((r) => r.session === SR);
  assert.ok(done, 'the finished run is not in «Claude done»');
  assert.equal(done.tasks_n, 3);
});
