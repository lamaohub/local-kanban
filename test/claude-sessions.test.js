// Claude Code sets CLAUDE_CODE_SESSION_ID for every command it runs; bin/kb sends it as
// X-Claude-Session, and the board ties the task to the session — but only for writes to a task in
// work or in review (grooming a backlog card is not work on it). Each status change also records
// the session that made it: a session often works through several tasks, and the work feed has to
// know where in the session's transcript one task ends and the next begins.
// The real bin/kb against the real task routes on a real socket, as in kb-checklist.test.js.
// The Claude directory is a temporary one (KB_CLAUDE_DIR), so nothing reads the real ~/.claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const SID_A = '11111111-2222-4333-8444-555555555555';
const SID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let app, tmp, claude, db, base, transcriptA;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  // the transcript of session A lives where Claude Code puts it; session B has none on this machine
  mkdirSync(join(claude, 'projects', '-Users-someone-project-a'), { recursive: true });
  transcriptA = join(claude, 'projects', '-Users-someone-project-a', `${SID_A}.jsonl`);
  writeFileSync(transcriptA, '{"type":"user"}\n');
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',6)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const [no, status] of [[1, 'todo'], [2, 'backlog'], [3, 'todo'], [4, 'doing'], [5, 'todo']]) {
    db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,?)').run(pid, no, `Task ${no}`, status);
  }
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

// kb as Claude runs it (with a session) or as a person runs it in a terminal (without one)
const kb = (args, sid) => new Promise((resolve) => {
  const env = { ...process.env, KB_URL: base };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (sid) env.CLAUDE_CODE_SESSION_ID = sid;
  execFile(process.execPath, [KB, ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const sessionsOf = (key) => db.prepare(`SELECT s.session_id FROM task_sessions s JOIN tasks t ON t.id = s.task_id
  WHERE t.task_no = ? ORDER BY s.session_id`).all(Number(key.split('-')[1])).map((r) => r.session_id);
const lastEvent = (key) => db.prepare(`SELECT e.status, e.session_id FROM task_events e JOIN tasks t ON t.id = e.task_id
  WHERE t.task_no = ? ORDER BY e.id DESC LIMIT 1`).get(Number(key.split('-')[1]));

test('a move into work from a Claude session ties the task to that session and records who moved it', async () => {
  const r = await kb(['mv', 'DM-1', 'prep'], SID_A);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-1'), [SID_A]);
  assert.deepEqual(lastEvent('DM-1'), { status: 'prep', session_id: SID_A },
    'the status change does not say which session made it, so the feed cannot cut the transcript by task');
});

test('grooming is not work: writes to a backlog card tie nothing to the session', async () => {
  for (const args of [['pri', 'DM-2', 'high'], ['desc', 'DM-2', 'Groomed'], ['lbl', 'DM-2', '+bug']]) {
    const r = await kb(args, SID_A);
    assert.equal(r.code, 0, r.stderr);
  }
  assert.deepEqual(sessionsOf('DM-2'), [], 'a grooming session would end up listed on every card it touched');
});

test('a person in their own terminal sends no session, and the move is recorded without one', async () => {
  const r = await kb(['mv', 'DM-3', 'prep']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-3'), []);
  assert.deepEqual(lastEvent('DM-3'), { status: 'prep', session_id: null });
});

test('a session id that is not a UUID is ignored, and the request itself still goes through', async () => {
  for (const sid of ['../../etc/passwd', 'abc', `${SID_A}/../x`, '']) {
    const res = await app.inject({ method: 'PATCH', url: '/api/tasks/DM-5', headers: { 'x-claude-session': sid }, payload: { status: 'prep' } });
    assert.equal(res.statusCode, 200, `a bad header must not cost the person their move (${sid})`);
    await app.inject({ method: 'PATCH', url: '/api/tasks/DM-5', payload: { status: 'todo' } });
  }
  assert.deepEqual(sessionsOf('DM-5'), []);
});

test('a note and a checklist tick from a session tie a task that is already in work', async () => {
  let r = await kb(['note', 'DM-4', 'halfway there'], SID_B);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-4'), [SID_B]);
  await app.inject({ method: 'POST', url: '/api/tasks/DM-4/checklist', payload: { text: 'step one' } });
  r = await kb(['check', 'DM-4', '1'], SID_B);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-4'), [SID_B]);
});

// became its latest session, and the card lost «Continue» of the real one.
test('a note or a tick from a session the task does not know does not take a task another session works on', async () => {
  let r = await kb(['note', 'DM-4', 'a word from the side'], SID_A);
  assert.equal(r.code, 0, r.stderr);
  r = await kb(['check', 'DM-4', '1'], SID_A);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-4'), [SID_B], 'the side session became one of the task — and its latest');

  // the session that is tied already keeps being refreshed by its own notes
  db.prepare("UPDATE task_sessions SET last_seen = '2000-01-01 00:00:00' WHERE session_id = ?").run(SID_B);
  r = await kb(['note', 'DM-4', 'still on it'], SID_B);
  assert.equal(r.code, 0, r.stderr);
  const seen = db.prepare('SELECT last_seen FROM task_sessions WHERE session_id = ?').get(SID_B).last_seen;
  assert.notEqual(seen, '2000-01-01 00:00:00', 'the own note did not refresh its session');

  // a move of the status is taking the task, and it still ties the session
  r = await kb(['mv', 'DM-4', 'deploy'], SID_A);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sessionsOf('DM-4'), [SID_A, SID_B].sort());

  // back to To do and into work again: the old sessions are history, and the first note ties the new one
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { status: 'todo' } });
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-4', payload: { status: 'doing' } });
  db.prepare("UPDATE task_sessions SET last_seen = '2000-01-01 00:00:00' WHERE task_id = (SELECT id FROM tasks WHERE task_no = 4)").run();
  db.prepare("UPDATE task_events SET created_at = '2000-01-01 00:00:01' WHERE task_id = (SELECT id FROM tasks WHERE task_no = 4)").run();
  const SID_D = 'dddddddd-eeee-4fff-8000-111111111111';
  r = await kb(['note', 'DM-4', 'picked up again'], SID_D);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(sessionsOf('DM-4').includes(SID_D), 'a session nobody holds the task against was not tied by its note');
});

test('the card lists its sessions, each with the transcript where this machine has one', async () => {
  await app.inject({ method: 'PATCH', url: '/api/tasks/DM-1', headers: { 'x-claude-session': SID_B }, payload: { status: 'doing' } });
  const t = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1' })).json();
  assert.deepEqual(t.sessions.map((s) => s.session_id), [SID_A, SID_B], 'oldest first');
  const [a, b] = t.sessions;
  assert.equal(a.transcript, transcriptA, 'the transcript is found by the session id, in whichever project folder it is');
  assert.equal(b.transcript, null, 'a session without a transcript here has none, rather than a guessed path');
  assert.ok(a.first_seen && a.last_seen);
});

test('a transcript is found in whichever project folder it is, not only in the first one', async () => {
  // two sessions, two folders: whatever order the folders are listed in, a search that stops at the
  // first one misses one of the two
  const { findTranscript } = await import('../src/claude-sessions.js');
  const SID_C = 'cccccccc-dddd-4eee-8fff-000000000000';
  mkdirSync(join(claude, 'projects', '-Users-someone-project-c'), { recursive: true });
  const transcriptC = join(claude, 'projects', '-Users-someone-project-c', `${SID_C}.jsonl`);
  writeFileSync(transcriptC, '{"type":"user"}\n');
  assert.equal(await findTranscript(SID_A), transcriptA);
  assert.equal(await findTranscript(SID_C), transcriptC);
});

test('kb show prints the sessions, and the transcript of an earlier session than the one asking', async () => {
  let r = await kb(['show', 'DM-1'], SID_B);
  assert.equal(r.code, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('claude sessions:'));
  assert.ok(line, `kb show does not print the sessions the card shows:\n${r.stdout}`);
  assert.match(line, /^claude sessions: 2, last \[\d{4}-\d\d-\d\d \d\d:\d\d\]/);
  assert.ok(line.endsWith(`earlier transcript: ${transcriptA}`), `session B should be pointed at A's transcript:\n${line}`);

  r = await kb(['show', 'DM-1'], SID_A);
  const own = r.stdout.split('\n').find((l) => l.startsWith('claude sessions:'));
  assert.doesNotMatch(own, /transcript/, 'the only other session has no transcript here, so there is nothing to point at');

  r = await kb(['show', 'DM-3']);
  assert.equal(r.stdout.split('\n').some((l) => l.startsWith('claude sessions:')), false, 'no sessions — no line');
});
