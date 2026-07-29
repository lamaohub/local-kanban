import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp, db, taskEvent, listShape, tid;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ taskEvent, listShape } = await import('../src/task-shape.js'));

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, labels, gh_issue_number, gh_issue_url)
              VALUES (?, 1, 'Task', 'todo', '["bug"]', 42, 'https://github.com/o/r/issues/42')`).run(pid);
  tid = db.prepare('SELECT id FROM tasks WHERE task_no = 1').get().id;
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('taskEvent carries key — the very field the worker\'s event was missing', () => {
  const ev = taskEvent(tid);
  assert.equal(ev.key, 'DM-1');
  assert.equal(ev.project, 'demo');
});

test('taskEvent returns labels as an array, not a JSON string', () => {
  const ev = taskEvent(tid);
  assert.ok(Array.isArray(ev.labels), 'labels must be an array in both shapes of the event');
  assert.deepEqual(ev.labels, ['bug']);
});

test('taskEvent carries the issue number and url — the reason the worker emits at all', () => {
  const ev = taskEvent(tid);
  assert.equal(ev.gh_issue_number, 42);
  assert.equal(ev.gh_issue_url, 'https://github.com/o/r/issues/42');
});

test('taskEvent matches listShape — one shape, not two', () => {
  const row = db.prepare(`
    SELECT t.*, p.slug AS project, (p.prefix || '-' || t.task_no) AS key
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(tid);
  assert.deepEqual(Object.keys(taskEvent(tid)).sort(), Object.keys(listShape(row)).sort());
});

test('taskEvent on a deleted task returns null instead of throwing', () => {
  assert.equal(taskEvent(999999), null);
});

test('worker.js emits task.updated only through taskEvent', () => {
  const src = readFileSync(join(ROOT, 'src/sync/worker.js'), 'utf8');
  const emits = src.match(/emit\('task\.updated',[^\n]*/g) || [];
  assert.ok(emits.length > 0, 'the task.updated emit must exist in the worker');
  for (const line of emits) {
    assert.ok(line.includes('taskEvent('), `the event is built outside the shared shape: ${line.trim()}`);
  }
});
