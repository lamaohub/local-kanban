// holds it: the real `bin/kb` against the real routes, from a session, on a task in Review.
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
const SID = '11111111-2222-4333-8444-555555555555';
let app, tmp, db, base, id;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Handed in','review')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_events (task_id, status, session_id) VALUES (?, 'review', ?)").run(id, SID);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const kb = (args) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, CLAUDE_CODE_SESSION_ID: SID };
  delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('notes of the session on a task in Review leave it there, with no move in the journal', async () => {
  for (const words of ['SPF is set to -all', 'the support ticket is opened']) {
    const r = await kb(['note', 'DM-1', words]);
    assert.equal(r.code, 0, r.stderr);
  }
  const t = db.prepare('SELECT status, work_started_at FROM tasks WHERE id = ?').get(id);
  assert.equal(t.status, 'review');
  assert.equal(t.work_started_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get(id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n, 2);
});
