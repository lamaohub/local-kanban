// be printed as the human's.
//  - `kb take` printed only the LAST human note: a send-back followed by a second note lost the first.
//  - `kb show` printed the last five comments of any author: Claude's own notes and the commit stats
//    pushed the human's note out of the window without a word.
//  - comments had no dates, so a fresh send-back looked exactly like an old one already dealt with.
//  - the commit stat the board attaches by itself (author 'git') was marked 👤, as if the human said it.
// The real binary `bin/kb` against the real task routes on a real socket, like kb-checklist.test.js.
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
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',4)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const task = (no, status) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,?)')
    .run(pid, no, `Task ${no}`, status).lastInsertRowid;
  const say = (id, author, body, at) => db.prepare('INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?,?,?,?)')
    .run(id, author, body, at);

  // DM-1 (todo): a note already answered, Claude's report, then a send-back, a commit and a follow-up
  const t1 = task(1, 'todo');
  say(t1, 'me', 'Old note, already answered', '2026-09-01 09:00:00');
  say(t1, 'claude', 'Report: done', '2026-09-01 10:00:00');
  say(t1, 'me', 'Send back: the button is still white', '2026-09-02 11:30:00');
  say(t1, 'git', 'abc1234 Button colour\n 1 file changed', '2026-09-02 11:40:00');
  say(t1, 'me', 'And the label is cut off on a phone', '2026-09-02 12:05:00');

  // DM-2: the human's note is sixth from the end — outside the old window of five
  const t2 = task(2, 'review');
  say(t2, 'claude', 'Report', '2026-09-03 08:00:00');
  say(t2, 'me', 'Important: do not touch the prices', '2026-09-03 09:00:00');
  for (let i = 0; i < 5; i++) say(t2, 'git', `def00${i}0 Commit ${i}\n 2 files changed`, `2026-09-03 10:0${i}:00`);

  // DM-3 (todo): the human's note was answered by a report, nothing new since
  const t3 = task(3, 'todo');
  say(t3, 'me', 'Use the dark palette', '2026-09-04 09:00:00');
  say(t3, 'claude', 'Report: switched to the dark palette', '2026-09-04 10:00:00');

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// TZ is pinned so the printed local time is the stored UTC time
const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base, TZ: 'UTC' } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('kb take prints every human note since the last report, dated — not just the latest one', async () => {
  const r = await run(['take', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^> 👤 \[2026-09-02 11:30\] Send back: the button is still white$/m, `the send-back was lost:\n${r.stdout}`);
  assert.match(r.stdout, /^> 👤 \[2026-09-02 12:05\] And the label is cut off on a phone$/m);
  assert.doesNotMatch(r.stdout, /Old note, already answered/, 'a note Claude already reported on is not news');
  assert.match(r.stdout, /^… 3 more comments not printed/m, 'what was left out has to be counted, not dropped silently');
});

test('kb show keeps the human note even when newer comments fill the window', async () => {
  const r = await run(['show', 'DM-2']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^> 👤 \[2026-09-03 09:00\] Important: do not touch the prices$/m, `the human note was pushed out:\n${r.stdout}`);
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('> ⎇')).length, 5, 'the last five comments are still printed');
  assert.match(r.stdout, /^… 1 more comment not printed/m);
});

test('a commit stat is marked as a commit, never as the human', async () => {
  const r = await run(['show', 'DM-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^> ⎇ \[2026-09-02 11:40\] commit abc1234 Button colour$/m, `the commit is not marked:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /^> 👤 .*abc1234/m, 'the commit stat is printed as the human speaking');
});

test('with nothing new since the report, take still prints the last human note, with its date', async () => {
  const r = await run(['take', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^DM-3 prep /m);
  assert.match(r.stdout, /^> 👤 \[2026-09-04 09:00\] Use the dark palette$/m, `the dated note is missing:\n${r.stdout}`);
  assert.match(r.stdout, /^… 1 more comment not printed/m);
});
