// The audit of 14.11.2026: every tab asks the list of projects after every move of a task, and it was counted anew each time,
// the board's switch of Ready to ship read from kv once a project. The answer is kept until an event that may change its
// figures, and the switch is read once an answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db, emit, pid;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-projects-cache-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ emit } = await import('../src/bus.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  for (let i = 1; i <= 8; i++) db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no) VALUES (?, ?, ?, 10)').run(`p${i}`, `P${i}X`, `P ${i}`);
  pid = db.prepare("SELECT id FROM projects WHERE slug = 'p1'").get().id;
  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const todo = async () => (await app.inject('/api/projects')).json().find((p) => p.slug === 'p1').c_todo;

test('the list of projects is kept until an event that changes its figures', async () => {
  emit('project.updated', {});
  assert.equal(await todo(), 0);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pid); // no event
  assert.equal(await todo(), 0, 'not kept');
  for (const type of ['task.comment', 'task.work', 'task.live', 'session.chat']) { emit(type, { id: 1 }); assert.equal(await todo(), 0, `${type} dropped it`); }
  emit('task.updated', { id: 1 });
  assert.equal(await todo(), 1);
  db.prepare("UPDATE tasks SET status = 'doing' WHERE project_id = ?").run(pid);
  emit('task.created', {});
  assert.equal(await todo(), 0);
  // an order of the projects changed sends no event, and is seen at once
  const slugs = ['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1'];
  const r = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: { slugs } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual((await app.inject('/api/projects')).json().map((p) => p.slug), slugs);
});

test('the switch of Ready to ship is read once for the whole list, and the answer says it for every project', async () => {
  let reads = 0;
  const prepare = db.prepare;
  db.prepare = function counted(sql) { if (/FROM kv\b/.test(sql)) reads += 1; return prepare.call(this, sql); };
  try {
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('flow.ready_gate', '1')").run();
    db.prepare('UPDATE projects SET ready_gate = 0 WHERE slug = ?').run('p3');
    emit('project.updated', { flow: true });
    reads = 0;
    const list = (await app.inject('/api/projects')).json();
    assert.equal(reads, 1, `the switch read ${reads} times for ${list.length} projects`);
    assert.deepEqual(list.filter((p) => !p.ship_gate).map((p) => p.slug), ['p3']);
  } finally { db.prepare = prepare; }
});
