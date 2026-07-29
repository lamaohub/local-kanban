import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;

  db.exec(`
    INSERT INTO tasks (project_id, task_no, title, description, status, priority, created_at, updated_at, done_at) VALUES
     (${pid}, 1, 'hot',    'd', 'backlog', 3, datetime('now','-20 days'), datetime('now','-20 days'), NULL),
     (${pid}, 2, 'queue',  'd', 'todo',    2, datetime('now','-1 days'),  datetime('now','-1 days'),  NULL),
     (${pid}, 3, 'decide', '',  'backlog', 0, datetime('now','-20 days'), datetime('now','-20 days'), NULL),
     (${pid}, 4, 'idea',   'd', 'todo',    1, datetime('now','-1 days'),  datetime('now','-1 days'),  NULL),
     (${pid}, 5, 'prep',   'd', 'prep',    1, datetime('now','-2 days'),  datetime('now','-2 days'),  NULL),
     (${pid}, 6, 'doing',  'd', 'doing',   1, datetime('now','-2 days'),  datetime('now','-2 days'),  NULL),
     (${pid}, 7, 'deploy', 'd', 'deploy',  1, datetime('now','-2 days'),  datetime('now','-2 days'),  NULL),
     (${pid}, 8, 'review', 'd', 'review',  1, datetime('now','-2 days'),  datetime('now','-2 days'),  NULL),
     (${pid}, 9, 'done-w', 'd', 'done',    2, datetime('now','-5 days'),  datetime('now','-3 days'),  datetime('now','-3 days')),
     (${pid}, 10,'done-m', 'd', 'done',    1, datetime('now','-25 days'), datetime('now','-20 days'), datetime('now','-20 days'));
  `);
  db.exec(`
    INSERT INTO task_events (task_id, status, created_at) VALUES
     (2, 'todo',  datetime('now')),
     (2, 'doing', datetime('now')),
     (2, 'review',datetime('now')),
     (6, 'todo',  datetime('now')),
     (6, 'doing', datetime('now'));
  `);

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.register(dashboardRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const dash = async (range) => (await app.inject({ method: 'GET', url: `/api/dashboard${range ? `?range=${range}` : ''}` })).json();

test('?range filters done_period; done_total and active stay absolute', async () => {
  const week = await dash('week');
  assert.equal(week.summary.done_total, 2);
  assert.equal(week.summary.done_period, 1, 'one done this week (-3d), the second at -20d is outside the window');
  assert.equal(week.summary.active, 6, 'todo+prep+doing+deploy+review');
  const month = await dash('month');
  assert.equal(month.summary.done_period, 2, 'over a month both done tasks fall in');
  assert.ok(week.summary.cycle_hours_period > 0, 'the average cycle over the window is computed');
});

test('?range with a prototype key does not blank the summary, it falls back to week', async () => {
  const bad = await dash('constructor');
  assert.equal(bad.range, 'week', 'a junk range falls back to week');
  assert.equal(bad.summary.done_period, 1, 'junk in datetime() does not blank the summary');
  const bad2 = await dash('toString');
  assert.equal(bad2.range, 'week');
});

test('queue: todo_ready and backlog', async () => {
  const d = await dash('week');
  assert.equal(d.queue.todo_ready, 2);
  assert.equal(d.queue.backlog, 2);
});

test('funnel: counts per active stage', async () => {
  const d = await dash('week');
  const f = Object.fromEntries(d.planning.funnel.map((s) => [s.status, s.n]));
  assert.deepEqual(f, { backlog: 2, todo: 2, prep: 1, doing: 1, deploy: 1, review: 1 });
});

test('the priority×staleness matrix sorts into hot/queue/decide/idea', async () => {
  const { matrix } = (await dash('week')).planning;
  const has = (bucket, key) => matrix[bucket].some((t) => t.key === key);
  assert.ok(has('hot', 'DM-1'),    'important and idle for 14+ days');
  assert.ok(has('queue', 'DM-2'),  'important and fresh');
  assert.ok(has('decide', 'DM-3'), 'no priority and idle');
  assert.ok(has('idea', 'DM-4'),   'no priority and fresh');
});

test('\'what to pick up\': only tasks with both a description and a priority, ranked', async () => {
  const { next } = (await dash('week')).planning;
  assert.deepEqual(next.map((t) => t.key), ['DM-1', 'DM-2', 'DM-4'], 'DM-3 without a priority or description is filtered out');
});

test('the heatmap counts DISTINCT tasks, not transitions', async () => {
  const d = await dash('week');
  const total = d.heat_days.reduce((s, r) => s + r.n, 0);
  assert.equal(total, 2, '2 tasks with events (not 5 events)');
  assert.ok(d.heat_days.every((r) => r.n <= 2));
});

test('the recent feed shows the latest status per task (MAX id), no duplicates', async () => {
  const d = await dash('week');
  const byKey = Object.fromEntries(d.recent.map((r) => [r.key, r.status]));
  assert.equal(d.recent.length, 2, 'one row per task, not per transition');
  assert.equal(byKey['DM-2'], 'review');
  assert.equal(byKey['DM-6'], 'doing');
});

test('\'waiting for you\': a review task lands in waiting.review', async () => {
  const d = await dash('week');
  assert.ok(d.waiting.review.some((t) => t.key === 'DM-8'));
});
