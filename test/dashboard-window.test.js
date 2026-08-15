import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, pid, emit;

before(async () => {
  process.env.TZ = 'Asia/Yekaterinburg';
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ emit } = await import('../src/bus.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
  pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;

  app = Fastify();
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

let no = 0;
function doneAtLocal(mods, labels = '[]') {
  const expr = ["'now'", "'localtime'", ...mods.map((m) => `'${m}'`), "'utc'"].join(', ');
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, labels, done_at, created_at)
              VALUES (?,?,?, 'done', ?, datetime(${expr}), datetime('now','-30 days'))`)
    .run(pid, ++no, `t${no}`, labels);
}
const dash = async (range = 'week') => {
  emit('test.tick', {});
  return (await app.inject({ method: 'GET', url: `/api/dashboard?range=${range}` })).json();
};
const stats = async () => (await app.inject({ method: 'GET', url: '/api/stats' })).json();

test('the left edge of the window is local midnight, not an instant N days ago', async () => {
  doneAtLocal(['start of day', '-6 days', '+30 minutes']);
  const d = await dash('week');
  assert.equal(d.summary.done_period, 1,
    'a task finished early in the morning of a day the calendar draws in full is missing from the summary');

  const firstDay = db.prepare("SELECT strftime('%Y-%m-%d','now','localtime','start of day','-6 days') AS d").get().d;
  assert.equal(d.range_since, firstDay, 'the calendar starts on a different day than the numbers do');
});

test('a task finished just before the window still stays out', async () => {
  doneAtLocal(['start of day', '-6 days', '-1 minutes']);
  const d = await dash('week');
  assert.equal(d.summary.done_period, 1, 'the window swallowed a day it should not have');
});

test('the header and the dashboard count the week the same way', async () => {
  doneAtLocal(['start of day', '-1 days', '+10 hours'], '["noclaude"]');
  const d = await dash('week');
  const s = await stats();
  assert.equal(d.summary.manual_period, 1, 'the manual task is not counted as manual');
  assert.equal(s.week_done, d.summary.done_period,
    `the topbar says ${s.week_done} and the dashboard says ${d.summary.done_period} for the same week`);
});
