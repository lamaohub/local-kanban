// terminals» — while its card said «Session interrupted from outside» with «Continue» (the owner's TIC-199, TBF-182).
// Such a run stays, with `ended`, as long as its terminal stands and its tasks wait on the person; it is not in «Claude
// done» meanwhile. One that ended by itself, one whose task was accepted, and one whose terminal is gone are done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SP = '77777777-7777-4777-8777-777777777777'; // handed TX-1 in to Review, then killed from outside in its terminal
let app, tmp, claude, now, db, live;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  process.env.KB_TMUX_SOCKET = `kb-parked-none-${process.pid}`; // no server is ever started on it: tmux says «no terminal»
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  now = await import('../src/claude-now.js');
  live = await import('../src/claude-live.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('tix','TX','Tickets',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'tix'").get().id;
  for (const no of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
  for (const st of ['prep', 'doing', 'review']) {
    const r = await app.inject({ method: 'PATCH', url: '/api/tasks/TX-1', headers: { 'x-claude-session': SP }, payload: { status: st } });
    assert.equal(r.statusCode, 200, r.body);
  }
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(SP);
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const nobodyAlive = () => false;
const look = (dead) => async () => ({ live: [], questions: [], background: [], over: [], limited: [], dead });
const killed = async () => ({ dead: true, exit: null, signal: 'kill' });
const exited = async () => ({ dead: true, exit: 0, signal: '' });
const runOf = async (paneOf) => (await now.nowRuns(nobodyAlive, paneOf)).runs.find((r) => r.session === SP);
const inDone = (active = []) => now.doneRuns({ active }).runs.some((r) => r.session === SP);

test('killed from outside with its task in Review, the run stays in «Claude now» as a broken terminal, not in «Claude done»', async () => {
  await live.refreshLive(nobodyAlive, look([SP]));
  const run = await runOf(killed);
  assert.ok(run, 'the interrupted run waiting on the person is gone from «Claude now»');
  assert.equal(run.claude, 'gone');
  assert.equal(run.stale, false, 'stopped from outside it is shown with its screen, not folded');
  assert.equal(run.ended?.interrupted, true, 'no `ended`: «Broken terminals» does not take it and «Continue» is not offered');
  assert.equal(run.board, true);
  assert.deepEqual(run.tasks.map((t) => [t.key, t.status]), [['TX-1', 'review']]);
  assert.equal((await now.nowRuns(nobodyAlive, killed)).tasks_n, 0, 'a task in Review counted as one in work');
  const parked = await now.parkedBoardSessions(new Map(), killed);
  assert.deepEqual([...parked], [SP]);
  assert.equal(inDone([...parked]), false, 'one run in both sections');
});

test('one that ended by itself, or whose terminal the board no longer has, is done as before', async () => {
  await live.refreshLive(nobodyAlive, look([SP]));
  assert.equal(await runOf(exited), undefined, 'a Claude that exited by itself (/exit) held its run in «Claude now»');
  assert.equal((await now.parkedBoardSessions(new Map(), exited)).size, 0);
  await live.refreshLive(nobodyAlive, look([]));
  assert.equal(await runOf(killed), undefined, 'a run whose terminal is gone (closed by the sweep) stayed in «Claude now»');
  assert.equal(inDone(), true, 'the finished run is not in «Claude done»');
});

test('the person accepted the task: the stopped run leaves «Claude now»', async () => {
  await live.refreshLive(nobodyAlive, look([SP]));
  db.prepare("UPDATE tasks SET status = 'done' WHERE task_no = 1").run();
  try {
    assert.equal(await runOf(killed), undefined, 'an accepted run still held «Claude now»');
  } finally {
    db.prepare("UPDATE tasks SET status = 'review' WHERE task_no = 1").run();
  }
});

// the routes take the terminal's state from tmux itself: here tmux has no server, and the conversation on disk makes it
test('/api/now and /api/done agree: the run is in the first and not in the second', async () => {
  const transcript = join(claude, `${SP}.jsonl`);
  writeFileSync(transcript, '{}\n');
  db.prepare('UPDATE task_sessions SET transcript = ? WHERE session_id = ?').run(transcript, SP);
  await live.refreshLive(nobodyAlive, look([SP]));
  const nowRes = JSON.parse((await app.inject({ method: 'GET', url: '/api/now' })).body);
  assert.ok(nowRes.runs.some((r) => r.session === SP && r.ended?.interrupted), 'the run is not in /api/now');
  const doneRes = JSON.parse((await app.inject({ method: 'GET', url: '/api/done' })).body);
  assert.equal(doneRes.runs.some((r) => r.session === SP), false, '/api/done shows the run «Claude now» shows');
});
