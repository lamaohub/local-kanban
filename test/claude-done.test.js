// work and at least one handed in, the most recently finished first. A run is the latest session of a task, the
// same as in "Claude now", so a run moves here when it leaves there. Hand-ins no session is tied to are put
// together by project and time; manual tasks are not Claude's work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const S1 = '11111111-1111-4111-8111-111111111111'; // a batch of two, finished
const S2 = '22222222-2222-4222-8222-222222222222'; // still has a task in work
const S3 = '33333333-3333-4333-8333-333333333333'; // a single task, finished later than S1
let app, tmp, db, done;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  done = await import('../src/claude-now.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DN','Demo board',20)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('other','OT','Other board',5)").run();
  const pid = (slug) => db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
  for (let no = 1; no <= 12; no++) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid('demo'), no, `Task ${no}`);
  for (const no of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid('other'), no, `Other ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const d of [tmp, process.env.KB_CLAUDE_DIR]) if (d) rmSync(d, { recursive: true, force: true });
});

const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: sid ? { 'x-claude-session': sid } : {}, payload: { status } });
const idOf = (key) => {
  const [prefix, no] = key.split('-');
  return db.prepare('SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix = ? AND t.task_no = ?').get(prefix, Number(no)).id;
};
// put the last move of a task into `status` `minutes` ago — the seconds of the test are all the same otherwise
const at = (key, status, minutes) => db.prepare(`UPDATE task_events SET created_at = datetime('now', ?) WHERE id = (SELECT MAX(id) FROM task_events WHERE task_id = ? AND status = ?)`)
  .run(`-${minutes} minutes`, idOf(key), status);
const keysOf = (run) => run.tasks.map((t) => t.key);

test('nothing handed in: no runs', async () => {
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/done' })).json(), { runs: [] });
});

test('a run is here once none of its tasks is in work; the most recently finished first', async () => {
  for (const k of ['DN-1', 'DN-2']) { await move(k, 'prep', S1); await move(k, 'doing', S1); await move(k, 'review', S1); }
  at('DN-1', 'review', 50); at('DN-2', 'review', 40);
  await move('DN-3', 'prep', S2); await move('DN-3', 'doing', S2); await move('DN-3', 'review', S2);
  await move('DN-4', 'prep', S2); await move('DN-4', 'doing', S2); // S2 still works on DN-4
  await move('DN-5', 'prep', S3); await move('DN-5', 'doing', S3); await move('DN-5', 'review', S3);
  at('DN-5', 'review', 10);
  const d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.deepEqual(d.runs.map((r) => r.session), [S3, S1], 'a run still holding a task in work is in "Claude done", or the order is not newest first');
  const s1 = d.runs[1];
  assert.deepEqual(keysOf(s1), ['DN-1', 'DN-2'], 'the run lists its tasks in the order it handed them in');
  assert.deepEqual([s1.tasks_n, s1.review_n, s1.done_n], [2, 2, 0]);
  assert.equal(s1.finished_at, s1.tasks[1].handed_at, 'a run finished at its last hand-in');
});

test('a task the person accepted counts as accepted; a task sent back to work leaves the run', async () => {
  await move('DN-1', 'done');
  let s1 = (await app.inject({ method: 'GET', url: '/api/done' })).json().runs.find((r) => r.session === S1);
  assert.deepEqual([s1.review_n, s1.done_n], [1, 1]);
  assert.ok(s1.tasks.find((t) => t.key === 'DN-1').done_at, 'an accepted task does not say when it was accepted');
  await move('DN-2', 'doing', S1); // sent back, the same session picks it up again
  const d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.equal(d.runs.find((r) => r.session === S1), undefined, 'a run with a task back in work stays in "Claude done"');
  await move('DN-2', 'review', S1);
  s1 = (await app.inject({ method: 'GET', url: '/api/done' })).json().runs.find((r) => r.session === S1);
  assert.deepEqual(keysOf(s1), ['DN-1', 'DN-2']);
});

test('a run finished longer ago than the window is not listed', async () => {
  at('DN-5', 'review', (done.DONE_DAYS + 1) * 24 * 60);
  const d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.equal(d.runs.find((r) => r.session === S3), undefined);
});

test('hand-ins without a session: one project in a row, no more than an hour apart, make one run; manual tasks are not here', async () => {
  for (const k of ['DN-7', 'DN-8', 'DN-9', 'OT-1', 'DN-10']) { await move(k, 'prep'); await move(k, 'doing'); await move(k, 'review'); }
  at('DN-7', 'review', 200); at('DN-8', 'review', 170); // 30 minutes apart: one run
  at('DN-9', 'review', 60);                             // 110 minutes after DN-8: a run of its own
  at('OT-1', 'review', 165);                            // another project: its own run
  db.prepare(`UPDATE tasks SET labels = '["noclaude"]' WHERE id = ?`).run(idOf('DN-10'));
  const loose = (await app.inject({ method: 'GET', url: '/api/done' })).json().runs.filter((r) => r.session === null);
  assert.deepEqual(loose.map(keysOf), [['DN-9'], ['OT-1'], ['DN-7', 'DN-8']], 'hand-ins without a session are put together wrong');
  assert.equal(loose[2].started_at, loose[2].tasks[0].handed_at, 'a run without a session starts at its first hand-in');
});

test('a manual task is not Claude\'s work, and a task in work on an archived board does not hold a run back', async () => {
  const S4 = '44444444-4444-4444-8444-444444444444';
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, archived) VALUES ('gone','GN','Gone board',2,0)").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug='gone'),1,'Left','todo')").run();
  for (const k of ['DN-11', 'DN-12']) { await move(k, 'prep', S4); await move(k, 'doing', S4); }
  await move('DN-11', 'review', S4);
  db.prepare(`UPDATE tasks SET labels = '["noclaude"]' WHERE id = ?`).run(idOf('DN-12')); // the person's own task, left in Doing
  await move('GN-1', 'prep', S4); await move('GN-1', 'doing', S4);
  db.prepare("UPDATE projects SET archived = 1 WHERE slug = 'gone'").run();
  let run = done.doneRuns().runs.find((r) => r.session === S4);
  assert.ok(run, 'a manual task in work, or a task on an archived board, keeps the run out of "Claude done"');
  assert.deepEqual(keysOf(run), ['DN-11']);
  await move('DN-12', 'review', S4);
  run = done.doneRuns().runs.find((r) => r.session === S4);
  assert.deepEqual(keysOf(run), ['DN-11'], 'a manual task is listed as Claude\'s work');
});

test('a run is never in "Claude now" and "Claude done" at once', async () => {
  const S6 = '66666666-6666-4666-8666-666666666666';
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug='demo'),?,'T','todo')");
  const no = db.prepare("SELECT next_task_no AS n FROM projects WHERE slug='demo'").get().n;
  add.run(no); add.run(no + 1);
  db.prepare("UPDATE projects SET next_task_no = ? WHERE slug='demo'").run(no + 2);
  const [a, b] = [`DN-${no}`, `DN-${no + 1}`];
  for (const k of [a, b]) { await move(k, 'prep', S6); await move(k, 'doing', S6); }
  await move(a, 'review', S6);
  db.prepare(`UPDATE tasks SET labels = '["noclaude"]' WHERE id = ?`).run(idOf(b));
  const now = await done.nowRuns(() => false);
  const doneS = new Set(done.doneRuns().runs.map((r) => r.session).filter(Boolean));
  const both = now.runs.map((r) => r.session).filter((s) => s && doneS.has(s));
  assert.deepEqual(both, [], 'one run stands in both sections');
  const manual = now.runs.find((r) => r.tasks.some((t) => t.key === b));
  assert.ok(manual && manual.session === null, 'a manual task in work is listed under the session that touched it');
  assert.ok(doneS.has(S6), 'the run that handed its task in is missing from "Claude done"');
});

test('at most DONE_RUNS runs', () => {
  assert.ok(done.doneRuns({ limit: 2 }).runs.length === 2);
});

test('an archived board, an old hand-in without a session and a task taken over by a newer session', async () => {
  const S7 = '77777777-7777-4777-8777-777777777777';
  const S8 = '88888888-8888-4888-8888-888888888888';
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('acc','AC','Acc board',7)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='acc'").get().id;
  for (let no = 1; no <= 6; no++) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Acc ${no}`);
  const handIn = async (k, sid) => { await move(k, 'prep', sid); await move(k, 'doing', sid); await move(k, 'review', sid); };
  // AC-1 handed in by S7, AC-2 by nobody (no session) — both on the board that is archived next
  await handIn('AC-1', S7); await handIn('AC-2');
  let d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.ok(d.runs.some((r) => r.session === S7) && d.runs.some((r) => r.tasks.some((t) => t.key === 'AC-2')));
  db.prepare("UPDATE projects SET archived = 1 WHERE slug='acc'").run();
  d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.equal(d.runs.find((r) => r.session === S7), undefined, 'a hand-in on an archived board is listed');
  assert.ok(!d.runs.some((r) => r.tasks.some((t) => t.key === 'AC-2')), 'a hand-in without a session on an archived board is listed');
  db.prepare("UPDATE projects SET archived = 0 WHERE slug='acc'").run();
  // a hand-in without a session older than the window
  await handIn('AC-3'); at('AC-3', 'review', (done.DONE_DAYS + 1) * 24 * 60);
  d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.ok(!d.runs.some((r) => r.tasks.some((t) => t.key === 'AC-3')), 'a hand-in without a session from before the window is listed');
  // AC-4 handed in by S7, sent back and handed in again by S8: it is S8's now
  await handIn('AC-4', S7);
  // the seconds of the test are all the same: S7 touched it ten minutes before S8 does
  db.prepare("UPDATE task_sessions SET last_seen = datetime('now', '-10 minutes'), first_seen = datetime('now', '-20 minutes') WHERE session_id = ?").run(S7);
  await move('AC-4', 'doing'); await move('AC-4', 'doing', S8); await move('AC-4', 'review', S8);
  d = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.ok(d.runs.find((r) => r.session === S8)?.tasks.some((t) => t.key === 'AC-4'), 'the task is not with the session that handed it in last');
  assert.ok(!d.runs.find((r) => r.session === S7)?.tasks.some((t) => t.key === 'AC-4'), 'the task stays with the session that had it before');
});
