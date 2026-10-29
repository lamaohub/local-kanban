// my board» restarts the board: the task stayed in Doing until the person asked Claude to put it back. The board here is
// restarted for real — the routes module evaluated anew on the same database — between the words and the end of the turn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let tmp;
let db;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-typed-'));
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_CLAUDE_DIR: join(tmp, 'claude') });
  ({ db } = await import('../src/db.js'));
});
after(() => { db?.close(); rmSync(tmp, { recursive: true, force: true }); });

const SID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

test('a task the words moved from Review goes back after the turn although the board was restarted in it', async () => {
  const repo = mkdtempSync(join(tmp, 'repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('rst', 'RST', 'Restart', 2, ?)").run(repo).lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status, work_seconds) VALUES (?, 1, 'T', 'review', 600)").run(pid).lastInsertRowid;
  const row = () => db.prepare('SELECT status, work_seconds FROM tasks WHERE id = ?').get(id);

  const first = await import('../src/routes/tasks.js');
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.deepEqual(first.moveTyped(t, SID), { prep: [], doing: ['RST-1'] });
  const at = Date.now();
  assert.equal(row().status, 'doing');
  for (let i = 0; i < 50 && !db.prepare('SELECT printed FROM typed_backs WHERE task_id = ?').get(id)?.printed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(db.prepare('SELECT printed FROM typed_backs WHERE task_id = ?').get(id)?.printed, 1, 'the words were not kept for the end of the turn');

  // the turn restarts the board: a new start of the routes on the same database
  const second = await import('../src/routes/tasks.js?restarted');
  assert.deepEqual(await second.settleTurns([{ id, status: 'doing', claude: 'busy', since: at + 1 }]), [], 'a turn still going on settled the words');
  assert.deepEqual(await second.settleTurns([{ id, status: 'doing', claude: 'idle', since: at + 1 }]), ['RST-1'],
    'after the restart the board no longer knew the words had moved the task: it stays in Doing');
  assert.deepEqual(row(), { status: 'review', work_seconds: 600 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM typed_backs').get().n, 0, 'a settled move is kept as waiting');
});

// cascade the delete failed on the foreign key
test('a task deleted while its words wait takes the waiting along', () => {
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('del', 'DEL', 'Del', 2)").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'doing')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO typed_backs (task_id, session_id, event_id, at_ms) VALUES (?, ?, 1, ?)').run(id, SID, Date.now());
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM typed_backs WHERE task_id = ?').get(id).n, 0);
});
