// The real bin/kb against the real task routes (as claude-sessions.test.js), text sentinels for the front.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const OLD = '11111111-2222-4333-8444-555555555555';
const NOW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SIDE = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let app, tmp, claude, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',6)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const no of [1, 2, 3, 4, 5]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const kb = (args, sid) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, CLAUDE_CODE_SESSION_ID: sid };
  delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const idOf = (no) => db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(no).id;
/** The session the card, Claude now and the live watch take for the task's: the latest one (liveTasks, pickSession). */
const latest = (no) => db.prepare('SELECT session_id FROM task_sessions WHERE task_id = ? ORDER BY last_seen DESC, session_id LIMIT 1').get(idOf(no))?.session_id;
const seen = (no, sid, at) => db.prepare('UPDATE task_sessions SET last_seen = ? WHERE task_id = ? AND session_id = ?').run(at, idOf(no), sid);

test('a session of an earlier round leaves a note: the task stays with the session on it now', async () => {
  await kb(['mv', 'DM-1', 'doing'], OLD);
  await kb(['review', 'DM-1', 'round one'], OLD);
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-1', payload: { status: 'todo' } });
  await kb(['mv', 'DM-1', 'doing'], NOW);
  seen(1, OLD, '2001-01-01 00:00:00');
  db.prepare("UPDATE task_events SET created_at = '2001-06-01 00:00:00' WHERE task_id = ? AND status = 'todo'").run(idOf(1));
  const r = await kb(['note', 'DM-1', 'by the way'], OLD);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(latest(1), NOW, 'a word from a session of the last round took the task back');
});

test('a session that wrote first and was overtaken does not take the task back with a tick or a note', async () => {
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-2', payload: { status: 'prep' } });
  await kb(['note', 'DM-2', 'first word'], OLD);
  await kb(['mv', 'DM-2', 'doing'], NOW);
  seen(2, OLD, '2001-01-01 00:00:00');
  await kb(['note', 'DM-2', 'again'], OLD);
  assert.equal(latest(2), NOW, 'the note took the task from the session that moved it');
});

test('an edit of a field from another session does not take the task; a move of the status does', async () => {
  await kb(['mv', 'DM-3', 'doing'], NOW);
  seen(3, NOW, '2001-01-01 00:00:00');
  await kb(['desc', 'DM-3', 'better words'], SIDE);
  assert.equal(latest(3), NOW, 'kb desc from the side took the task');
  await kb(['lbl', 'DM-3', '+bug'], SIDE);
  assert.equal(latest(3), NOW, 'kb lbl from the side took the task');
  await kb(['mv', 'DM-3', 'deploy'], SIDE);
  assert.equal(latest(3), SIDE, 'a move of the status no longer ties the session');
});

test('a session seen in the very second the task left work is of the work before it (`>`, not `>=`)', async () => {
  await kb(['mv', 'DM-4', 'doing'], OLD);
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { status: 'todo' } });
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { status: 'doing' } });
  const left = db.prepare("SELECT created_at FROM task_events WHERE task_id = ? AND status = 'todo' ORDER BY id DESC LIMIT 1").get(idOf(4)).created_at;
  seen(4, OLD, left);
  await kb(['note', 'DM-4', 'picked up again'], NOW);
  assert.ok(db.prepare('SELECT 1 FROM task_sessions WHERE task_id = ? AND session_id = ?').get(idOf(4), NOW), 'the first note of the new round tied nobody');
});

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
test('CK-873: System reads the colour scheme of the computer', () => {
  assert.match(read('js/settings.js'), /if \(t === 'system'\) mode = \(window\.matchMedia && window\.matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches\) \? 'dark' : 'light';/);
});
test('CK-874: Cancel puts the list back on the language of the page', () => {
  assert.match(read('js/settings.js'), /if \(\$\('sel-lang'\)\) langSelect\(\);/, 'the list stays on a language the page does not have');
});
test('CK-875: a tab coming back rewrites the times at once', () => {
  assert.match(read('js/drawer.js'), /document\.addEventListener\('visibilitychange', refreshCommentTimes\);/);
});
test('CK-876: a tab coming back checks the day at once', () => {
  assert.match(read('js/dash.js'), /document\.addEventListener\('visibilitychange', dayTurned\);/);
});
test('CK-893: a phone of 320 shows the short label of Broken terminals', () => {
  assert.match(read('style.css'), /@media \(max-width: 360px\) \{ \.now-view-long \{ display: none; \} \.now-view-short \{ display: inline; \} \}/);
});
