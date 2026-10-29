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

test('an archived project drops out of the funnel too, not just out of the other cards', async () => {
  const { bus } = await import('../src/bus.js');
  const funnel = async () => {
    bus.emit('event', { type: 'test.cache-bust' });
    return Object.fromEntries((await dash('week')).planning.funnel.map((s) => [s.status, s.n]));
  };
  const before = await funnel();
  db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('gone','GN','Archived')").run();
  const gid = db.prepare("SELECT id FROM projects WHERE slug='gone'").get().id;
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, description, status, priority)
              VALUES (?, 1, 'in an archived project', 'd', 'todo', 1)`).run(gid);
  const doneId = db.prepare(`INSERT INTO tasks (project_id, task_no, title, description, status, priority, done_at)
              VALUES (?, 2, 'done in an archived project', 'd', 'done', 1, datetime('now'))`).run(gid).lastInsertRowid;
  db.prepare("INSERT INTO task_events (task_id, status) VALUES (?, 'done')").run(doneId);
  const names = async () => {
    const d = await dash('week');
    return { top: d.top_projects.map((p) => p.name), recent: d.recent.map((r) => r.project) };
  };
  try {
    const live = await funnel();
    assert.equal(live.todo, before.todo + 1, 'a live project must be counted — otherwise the test proves nothing');
    const shown = await names();
    assert.ok(shown.top.includes('Archived') && shown.recent.includes('Archived'), 'a live project must be named — otherwise the test proves nothing');

    db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(gid);
    assert.deepEqual(await funnel(), before, 'the funnel still counts the tasks of an archived project');
    const hidden = await names();
    assert.ok(!hidden.top.includes('Archived'), 'the top projects name an archived project');
    assert.ok(!hidden.recent.includes('Archived'), 'the recent feed shows an archived project');
  } finally {
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(gid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(gid);
  }
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

test('the busiest hour, the recent feed and the heatmaps match the old full queries, after new events and after a deletion', async () => {
  const { emit } = await import('../src/bus.js');
  const full = () => ({
    peak: db.prepare(`SELECT h FROM (SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS h, COUNT(*) AS n
      FROM task_events GROUP BY h) ORDER BY n DESC, h LIMIT 1`).get()?.h ?? null,
    recent: db.prepare(`SELECT e.status, (p.prefix || '-' || t.task_no) AS key FROM task_events e
      JOIN (SELECT task_id, MAX(id) AS mid FROM task_events GROUP BY task_id) last ON last.mid = e.id
      JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
      ORDER BY e.id DESC LIMIT 30`).all().map((r) => `${r.key}:${r.status}`),
    days: db.prepare(`SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS d, COUNT(DISTINCT task_id) AS n FROM task_events
      WHERE created_at >= datetime('now','localtime','start of day','-6 days','utc') GROUP BY d ORDER BY d`).all(),
    time: db.prepare(`SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS w, CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS h,
      COUNT(DISTINCT task_id) AS n FROM task_events WHERE created_at >= datetime('now','localtime','start of day','-6 days','utc') GROUP BY w, h ORDER BY w, h`).all(),
  });
  const shown = async () => {
    emit('task.updated', {}); // the test writes to the base directly; a task event drops the cache, as on the board
    const d = await dash('week');
    return { peak: d.fun.peak_hour, recent: d.recent.map((r) => `${r.key}:${r.status}`), days: d.heat_days,
      time: [...d.heat_time].sort((a, b) => a.w - b.w || a.h - b.h) };
  };
  assert.deepEqual(await shown(), full());
  // a burst three hours ago, more than the events of now: the busiest hour moves
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const extra = db.prepare(`INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 50, 'burst', 'doing')`).run(pid).lastInsertRowid;
  const ins = db.prepare("INSERT INTO task_events (task_id, status, created_at) VALUES (?, ?, datetime('now', '-3 hours'))");
  for (let i = 0; i < 8; i++) ins.run(extra, i % 2 ? 'doing' : 'review');
  for (const t of [1, 3, 4, 5]) ins.run(t, 'todo'); // more tasks than one page of the walk would need
  const moved = await shown();
  assert.deepEqual(moved, full(), 'after new events the dashboard disagrees with a full pass');
  assert.equal(moved.peak, db.prepare("SELECT CAST(strftime('%H', datetime('now', '-3 hours'), 'localtime') AS INTEGER) AS h").get().h,
    'the burst did not move the busiest hour — the test proves nothing');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(extra); // its events go with it
  assert.deepEqual(await shown(), full(), 'after a deletion the busiest hour still counts the events that are gone');
});

test('events that do not change the numbers keep the cached answer; a task event drops it', async () => {
  const { emit } = await import('../src/bus.js');
  emit('task.updated', {});
  const before = (await dash('week')).queue.backlog;
  db.prepare("UPDATE tasks SET status = 'todo' WHERE task_no = 3").run(); // a change no route announced
  try {
    for (const type of ['task.work', 'task.live', 'task.comment', 'task.linked', 'task.attached', 'sync.status']) emit(type, {});
    assert.equal((await dash('week')).queue.backlog, before, `a quiet event dropped the cache`);
    emit('task.updated', {});
    assert.equal((await dash('week')).queue.backlog, before - 1, 'a task event did not drop the cache');
  } finally {
    db.prepare("UPDATE tasks SET status = 'backlog' WHERE task_no = 3").run();
    emit('task.updated', {});
  }
});
