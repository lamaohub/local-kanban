// (adoptBoardTerminals) and closes the ones whose tasks are out of play (startTerminalSweep). Both boards of the
// owner sit on one tmux socket and restart at every deploy, and no test ever called that start: a one-line slip —
// take every session of the socket, or none — made the board kill the other board's Claude with its context, or
// leave its own finished ones running for good, and the whole suite stayed green (the audit's mutations). Here
// two databases share a socket, and both boards start for real: the other one in a process of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-test-adopt-${process.pid}`;
// the sessions on the shared socket, all started before either board kept board_sessions
const OURS_DONE = 'aaaaaaaa-0000-4000-8000-000000000001';   // this board's, its task accepted
const OURS_WORK = 'aaaaaaaa-0000-4000-8000-000000000002';   // this board's, its task in work
const THEIRS_DONE = 'bbbbbbbb-0000-4000-8000-000000000001'; // the other board's, its task accepted
const THEIRS_WORK = 'bbbbbbbb-0000-4000-8000-000000000002'; // the other board's, its task in work
const NOBODYS = 'cccccccc-0000-4000-8000-000000000001';     // tied to a task in neither database
let ours, theirs, db, phantom;

before(async () => {
  ours = mkdtempSync(join(tmpdir(), 'kb-test-'));
  theirs = mkdtempSync(join(tmpdir(), 'kb-test-'));
  Object.assign(process.env, { KB_DATA_DIR: ours, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_DIR: join(ours, 'claude') });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const { tieLaunched } = await import('../src/claude-sessions.js');
  phantom = await import('../src/phantom.js');
  const p = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('ours', 'OUR', 'Ours', 3)").run().lastInsertRowid;
  const task = (n, status) => db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', ?)").run(p, n, status).lastInsertRowid;
  tieLaunched(task(1, 'done'), OURS_DONE);
  tieLaunched(task(2, 'doing'), OURS_WORK);
  if (TMUX) for (const sid of [OURS_DONE, OURS_WORK, THEIRS_DONE, THEIRS_WORK, NOBODYS]) execFileSync(TMUX, ['-L', SOCKET, 'new-session', '-d', '-s', `kb-${sid}`, 'sleep 600']);
});

after(() => {
  if (TMUX) { try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server left */ } }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  delete process.env.KB_TMUX_SOCKET; delete process.env.KB_CLAUDE_DIR;
  for (const d of [ours, theirs]) if (d) rmSync(d, { recursive: true, force: true });
});

const alive = (sid) => { try { execFileSync(TMUX, ['-L', SOCKET, 'has-session', '-t', `=kb-${sid}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const src = (f) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);

/** The other board: its own database, the same socket; it starts the way server.js starts it. */
function startTheirs() {
  const script = `
    const { db } = await import(${src('db.js')});
    const { tieLaunched } = await import(${src('claude-sessions.js')});
    const phantom = await import(${src('phantom.js')});
    const p = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('theirs', 'THR', 'Theirs', 3)").run().lastInsertRowid;
    const task = (n, status) => db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', ?)").run(p, n, status).lastInsertRowid;
    tieLaunched(task(1, 'done'), ${JSON.stringify(THEIRS_DONE)});
    tieLaunched(task(2, 'doing'), ${JSON.stringify(THEIRS_WORK)});
    await phantom.startTerminalSweep();
    // the last line: what it took in (the sweep writes its own line before it)
    process.stdout.write('\\n' + JSON.stringify(db.prepare('SELECT session_id FROM board_sessions ORDER BY session_id').all().map((r) => r.session_id)));
    process.exit(0);`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, KB_DATA_DIR: theirs, KB_CLAUDE_DIR: join(theirs, 'claude') }, timeout: 30000,
    }, (err, out, errOut) => (err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(JSON.parse(out.trim().split('\n').at(-1)))));
  });
}
const ourBoardSessions = () => db.prepare('SELECT session_id FROM board_sessions ORDER BY session_id').all().map((r) => r.session_id);

test('each board takes in at its start only the terminals tied to its own tasks, and closes only its own finished ones', { skip }, async () => {
  // the other board restarts first (a deploy): what it takes in is its own; the Claude of this board is left alone
  assert.deepEqual(await startTheirs(), [THEIRS_DONE, THEIRS_WORK], 'the other board took in sessions that are not tied to its tasks');
  assert.ok(alive(OURS_WORK), "the other board's start closed a working Claude of this board");
  assert.ok(alive(OURS_DONE) && alive(NOBODYS), "the other board's start closed sessions it does not know");
  assert.ok(!alive(THEIRS_DONE), "the other board did not close its own terminal whose task is accepted");
  // then this one
  await phantom.startTerminalSweep();
  assert.deepEqual(ourBoardSessions(), [OURS_DONE, OURS_WORK], 'this board took in sessions that are not tied to its tasks');
  assert.ok(!alive(OURS_DONE), 'this board did not close its own terminal whose task is accepted');
  assert.ok(alive(OURS_WORK), 'this board closed its own Claude whose task is in work');
  assert.ok(alive(THEIRS_WORK), "this board's start closed a working Claude of the other board");
  assert.ok(alive(NOBODYS), "this board's start closed a session neither board knows");
});

test('later sweeps keep to the terminals the board took in', { skip }, async () => {
  db.prepare("UPDATE tasks SET status = 'done' WHERE task_no = 2").run();
  assert.deepEqual(await phantom.closeFinishedTerminals(), [OURS_WORK]);
  assert.ok(alive(THEIRS_WORK) && alive(NOBODYS), "a sweep closed a session of the other board's or of nobody's");
});
