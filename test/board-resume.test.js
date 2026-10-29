// board at once (exit 143) — goes on in its own terminal: «Continue» is the board's start with `resume`, `claude
// --resume <its session>` in the project's folder, no prompt; nothing moves. Real tmux on a private socket, a stand-in
// for Claude that writes down how it was started and answers SIGTERM as Claude Code does (128 + 15).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-resume-${process.pid}`;
let app, tmp, folder, fakeLog, phantom, db, sessions, now;

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'kb-resume-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-resume-folder-')));
  const claudeDir = join(tmp, 'claude');
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } }));
  fakeLog = join(tmp, 'fake.log');
  mkdirSync(join(tmp, 'bin'));
  const fake = join(tmp, 'bin', 'claude');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(o) + '\\n');
log({ cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid });
process.on('SIGTERM', () => process.exit(143));
process.stdout.write('fake claude ready\\n');
process.stdin.setRawMode(true);
process.stdin.on('data', (s) => { if (String(s).includes('BYE')) process.exit(0); });
`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_BIN: fake, KB_CLAUDE_DIR: claudeDir, PORT: '3100' });
  delete process.env.KB_LAUNCH_DRYRUN;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  phantom = await import('../src/phantom.js');
  phantom.setLookHold(0);
  sessions = await import('../src/claude-sessions.js');
  now = await import('../src/claude-now.js');
  db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?,?,?,?,?)').run('res', 'RES', 'Resume', 8, folder);
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'res'").get().id;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pid, n);
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/chat.js')).default);
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.ready();
});

after(async () => {
  if (skip) return;
  await app?.close();
  try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server left */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_BIN', 'KB_CLAUDE_DIR', 'PORT']) delete process.env[k];
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

const entries = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}
const post = (payload) => app.inject({ method: 'POST', url: '/api/launch', payload });
const terminal = async (key) => (await app.inject({ method: 'GET', url: `/api/tasks/${key}/terminal` })).json();

test('the rule: stopped from outside is a signal or its code; an end of its own is not', () => {
  assert.equal(phantom.endedBySignal({ dead: true, exit: 143, signal: null }), true);
  assert.equal(phantom.endedBySignal({ dead: true, exit: 137, signal: null }), true);
  assert.equal(phantom.endedBySignal({ dead: true, exit: null, signal: 9 }), true, 'SIGKILL, which Claude cannot answer, is named by tmux');
  assert.equal(phantom.endedBySignal({ dead: true, exit: 0, signal: null }), false);
  assert.equal(phantom.endedBySignal({ dead: true, exit: 1, signal: null }), false);
  assert.equal(phantom.endedBySignal({ dead: false }), false);
  assert.equal(phantom.endedBySignal(null), false);
});

test('a Claude of the board killed by a signal reads interrupted, and «Continue» starts its own session again in its terminal', { skip }, async () => {
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-1'], text: 'Do RES-1', permission: 'auto' });
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  const first = await until(() => entries().find((e) => e.argv?.includes(sid)), 'the first Claude to start');
  process.kill(first.pid, 'SIGTERM'); // the stand-in this test started, by its own pid
  const dead = await until(async () => { const t = await terminal('RES-1'); return t.dead ? t : null; }, 'the terminal to die');
  assert.equal(dead.exit, 143);
  assert.equal(dead.interrupted, true, 'a Claude killed from outside does not read interrupted');
  // Claude now keeps it in sight, with how it ended (IB-206)
  const run = (await now.nowRuns(() => false)).runs.find((x) => x.session === sid);
  assert.equal(run.stale, false);
  assert.deepEqual(run.ended, { exit: 143, interrupted: true });
  const { liveTasks } = await import('../src/claude-live.js');
  const badge = (await liveTasks(() => false)).find((x) => x.key === 'RES-1');
  assert.equal(badge?.claude, 'gone');
  assert.equal(badge.interrupted, true, 'the card of the board reads «session closed» for a Claude stopped from outside');
  const { refreshLive } = await import('../src/claude-live.js');
  await refreshLive(() => false);
  const waits = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json().waiting.claude.find((x) => x.key === 'RES-1');
  assert.equal(waits?.claude, 'gone');
  assert.equal(waits.interrupted, true, 'the dashboard reads «session closed» for a Claude stopped from outside');

  // the chat offers Continue too — not «this Claude does not run inside the board»
  const chat = (await app.inject({ method: 'GET', url: `/api/tasks/RES-1/chat?session=${sid}` })).json();
  assert.deepEqual(chat.ended, { exit: 143, interrupted: true }, 'the chat does not know its Claude was interrupted');
  // the start of ▶ is long past: «starting» must come from Continue itself, not from the start's grace
  db.prepare("UPDATE task_events SET created_at = datetime('now', '-10 minutes') WHERE session_id = ?").run(sid);
  assert.ok(!sessions.freshLaunchSessions().has(sid));
  // Claude gave the task back with its questions and was killed: Continue moves nothing, not even to prep
  db.prepare("UPDATE tasks SET status = 'todo' WHERE task_no = 1").run();
  const before = entries().length;
  const go = await post({ mode: 'board', project: 'res', keys: ['RES-1'], resume: sid, permission: 'acceptEdits' });
  assert.equal(go.statusCode, 200, go.body);
  assert.equal(go.json().session, sid);
  assert.equal(go.json().resumed, true);
  assert.deepEqual(go.json().prep, [], 'Continue moved a task');
  const again = await until(() => entries().slice(before).find((e) => e.argv?.includes(sid)), 'Claude to go on');
  assert.equal(again.cwd, folder, 'Claude went on outside the project\'s folder — Claude Code would not find the conversation');
  const at = again.argv.indexOf('--resume');
  assert.ok(at >= 0 && again.argv[at + 1] === sid, `not --resume <its session>: ${JSON.stringify(again.argv)}`);
  assert.ok(!again.argv.includes('--session-id') && !again.argv.includes('Do RES-1'), 'a new session or the old prompt went with it');
  assert.equal(again.argv[again.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(again.argv[again.argv.indexOf('--name') + 1], 'RES-1');
  assert.ok(!again.argv.join(' ').includes('kb hook permission'), 'the hook\'s text is on the command line again');
  const alive = await terminal('RES-1');
  assert.equal(alive.session, sid, 'the card lost its terminal');
  assert.equal(alive.dead, false);
  assert.ok(sessions.freshLaunchSessions().has(sid), 'its cards would read «session closed» until Claude Code registers it');
  const st = db.prepare("SELECT status FROM tasks WHERE task_no = 1").get().status;
  assert.equal(st, 'todo', 'the task moved');

  // a second Continue on a live Claude is a running one, not a second Claude
  const twice = await post({ mode: 'board', project: 'res', keys: ['RES-1'], resume: sid });
  assert.equal(twice.statusCode, 409);
  assert.deepEqual(twice.json().running, ['RES-1']);
});

test('an end of Claude\'s own reads finished, not interrupted', { skip }, async () => {
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-2'], text: 'Do RES-2' });
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  await until(() => entries().find((e) => e.argv?.includes(sid)), 'Claude to start');
  execFileSync(TMUX, ['-L', SOCKET, 'send-keys', '-t', `=kb-${sid}:`, 'BYE']);
  const dead = await until(async () => { const t = await terminal('RES-2'); return t.dead ? t : null; }, 'the terminal to die');
  assert.equal(dead.exit, 0);
  assert.equal(dead.interrupted, false);
  const { liveTasks } = await import('../src/claude-live.js');
  const badge = (await liveTasks(() => false)).find((x) => x.key === 'RES-2');
  assert.equal(badge?.claude, 'gone');
  assert.equal(badge.interrupted, undefined, 'a Claude that ended itself reads interrupted on the card');
});

test('Continue goes only to a session of the board tied to these tasks, by its id and without a prompt', { skip }, async () => {
  const sid = db.prepare("SELECT s.session_id FROM task_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.task_no = 1").get().session_id;
  // a session of another task
  const other = await post({ mode: 'board', project: 'res', keys: ['RES-3'], resume: sid });
  assert.equal(other.statusCode, 404);
  assert.equal(other.json().reason, 'no-session');
  // a session the board never started
  const foreign = '12345678-1234-4123-8123-123456789abc';
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES ((SELECT id FROM tasks WHERE task_no = 3), ?, datetime('now'), datetime('now'))").run(foreign);
  const notBoard = await post({ mode: 'board', project: 'res', keys: ['RES-3'], resume: foreign });
  assert.equal(notBoard.statusCode, 404);
  for (const bad of [{ resume: 'nope' }, { resume: sid, text: 'go on' }, { resume: 42 }]) {
    const x = await post({ mode: 'board', project: 'res', keys: ['RES-1'], ...bad });
    assert.equal(x.statusCode, 400, JSON.stringify(bad));
  }
});

// two presses at once passed the lock of the keys (the keys differ), both saw the terminal dead, and the second either
// failed on tmux's «duplicate session» (500) or stopped the first one's fresh Claude.
test('two Continues of one session by its two tasks at once start one Claude; the other hears it is starting', { skip }, async () => {
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-4', 'RES-5'], text: 'Do RES-4 and RES-5' });
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  const first = await until(() => entries().find((e) => e.argv?.includes(sid)), 'Claude to start');
  process.kill(first.pid, 'SIGTERM');
  await until(async () => (await terminal('RES-4')).dead, 'the terminal to die');
  const before = entries().length;
  const both = await Promise.all([post({ mode: 'board', project: 'res', keys: ['RES-4'], resume: sid }), post({ mode: 'board', project: 'res', keys: ['RES-5'], resume: sid })]);
  assert.deepEqual(both.map((x) => x.statusCode).sort(), [200, 409], both.map((x) => x.body).join(' | '));
  assert.ok(both.find((x) => x.statusCode === 409).json().running?.length, 'the page reads «running» as started — it must get it');
  await until(() => entries().slice(before).some((e) => e.argv?.includes(sid)), 'Claude to go on');
  await new Promise((res) => { setTimeout(res, 600); });
  assert.equal(entries().slice(before).filter((e) => e.argv?.includes(sid)).length, 1, 'two Claudes started for one session');
  assert.equal((await terminal('RES-4')).dead, false, 'the Claude that went on was stopped by the other Continue');
});

test('Continue takes only the tasks of its session: a key it never held does not get its name and rules', { skip }, async () => {
  const sid = db.prepare("SELECT s.session_id FROM task_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.task_no = 2").get().session_id;
  const x = await post({ mode: 'board', project: 'res', keys: ['RES-2', 'RES-3'], resume: sid });
  assert.equal(x.statusCode, 404, x.body);
  assert.equal(x.json().reason, 'no-session');
});

// Continue of it must not stop that live Claude to start it again.
test('Continue of an older session of the task that still runs is refused, and its Claude lives on', { skip }, async () => {
  const one = await post({ mode: 'board', project: 'res', keys: ['RES-6'], text: 'Do RES-6' });
  const s1 = one.json().session;
  const c1 = await until(() => entries().find((e) => e.argv?.includes(s1)), 'the first Claude');
  process.kill(c1.pid, 'SIGTERM');
  await until(async () => (await terminal('RES-6')).dead, 'the first terminal to die');
  const two = await post({ mode: 'board', project: 'res', keys: ['RES-6'], text: 'Do RES-6 again' });
  assert.equal(two.statusCode, 200, two.body);
  const s2 = two.json().session;
  const c2 = await until(() => entries().find((e) => e.argv?.includes(s2)), 'the second Claude');
  db.prepare("UPDATE task_sessions SET last_seen = datetime('now', '+1 minute') WHERE session_id = ?").run(s2);
  process.kill(c2.pid, 'SIGTERM');
  await until(async () => { const t = await terminal('RES-6'); return t.session === s2 && t.dead; }, 'the second terminal to die');
  const back = await post({ mode: 'board', project: 'res', keys: ['RES-6'], resume: s1 });
  assert.equal(back.statusCode, 200, back.body);
  const c1b = await until(() => entries().filter((e) => e.argv?.includes(s1)).at(1), 'the first session to go on');
  const again = await post({ mode: 'board', project: 'res', keys: ['RES-6'], resume: s1 });
  assert.equal(again.statusCode, 409, again.body);
  assert.deepEqual(again.json().running, ['RES-6']);
  await new Promise((res) => { setTimeout(res, 400); });
  assert.equal(entries().filter((e) => e.argv?.includes(s1)).length, 2, 'a live Claude was stopped and started again');
  assert.doesNotThrow(() => process.kill(c1b.pid, 0), 'the live Claude of the session was stopped');
});

// macOS (tmux 3.5a) it names it by its NAME («kill»), not its number: read as a number, it read «Finished», and Claude now
// folded the run among the ones nobody leads.
test('a Claude of the board killed by SIGKILL reads interrupted too', { skip }, async () => {
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-7'], text: 'Do RES-7' });
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  const c = await until(() => entries().find((e) => e.argv?.includes(sid)), 'Claude to start');
  process.kill(c.pid, 'SIGKILL');
  const dead = await until(async () => { const t = await terminal('RES-7'); return t.dead ? t : null; }, 'the terminal to die');
  assert.equal(dead.interrupted, true, `killed by SIGKILL, it reads finished: ${JSON.stringify(dead)}`);
  const run = (await now.nowRuns(() => false)).runs.find((x) => x.session === sid);
  assert.equal(run.stale, false, 'Claude now folded a run killed from outside');
});

// every run read «session closed», folded, with no «Continue» — the chat said «this Claude does not run inside the
// board». `claude --resume` needs no terminal, only the conversation on disk: such a session goes on as an interrupted one.
test('a session of the board whose terminal is gone with tmux goes on by «Continue» while its conversation is kept', { skip }, async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'res'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 8, 'T', 'todo')").run(pid);
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-8'], text: 'Do RES-8' });
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  await until(() => entries().find((e) => e.argv?.includes(sid)), 'Claude to start');
  // its conversation, where Claude Code keeps it
  const dir = join(process.env.KB_CLAUDE_DIR, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'Do RES-8' } })}\n`);
  // the crash: the tmux server goes, and every terminal with it
  execFileSync(TMUX, ['-L', SOCKET, 'kill-server']);
  await until(async () => (await terminal('RES-8')).session === null, 'the terminal to be gone');
  db.prepare("UPDATE task_events SET created_at = datetime('now', '-10 minutes') WHERE session_id = ?").run(sid);
  const run = (await now.nowRuns(() => false)).runs.find((x) => x.session === sid);
  assert.equal(run.stale, false, 'Claude now folded the run among the ones nobody leads');
  assert.deepEqual(run.ended, { exit: null, interrupted: true, lost: true }, 'Claude now offers no «Continue»');
  const { liveTasks } = await import('../src/claude-live.js');
  const badge = (await liveTasks(() => false)).find((x) => x.key === 'RES-8');
  assert.equal(badge?.interrupted, true, 'the card reads «session closed»');
  const chat = (await app.inject({ method: 'GET', url: `/api/tasks/RES-8/chat?session=${sid}` })).json();
  assert.deepEqual(chat.ended, { exit: null, interrupted: true, lost: true }, 'the chat says «not inside the board»');

  const before = entries().length;
  const go = await post({ mode: 'board', project: 'res', keys: ['RES-8'], resume: sid });
  assert.equal(go.statusCode, 200, go.body);
  const again = await until(() => entries().slice(before).find((e) => e.argv?.includes(sid)), 'Claude to go on');
  assert.equal(again.argv[again.argv.indexOf('--resume') + 1], sid);
  assert.equal(again.cwd, folder);
  const alive = await terminal('RES-8');
  assert.equal(alive.session, sid);
  assert.equal(alive.dead, false);
});

test('the chat of an older session offers no «Continue» while a newer Claude of the board works on the task', { skip }, async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'res'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 9, 'T', 'todo')").run(pid);
  const old = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0891';
  db.prepare("INSERT INTO board_sessions (session_id) VALUES (?)").run(old);
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES ((SELECT id FROM tasks WHERE task_no = 9), ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))").run(old);
  const dir = join(process.env.KB_CLAUDE_DIR, 'projects', 'older');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${old}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: old, message: { role: 'user', content: 'Do RES-9' } })}\n`);
  // alone, its terminal gone: it goes on
  const alone = (await app.inject({ method: 'GET', url: `/api/tasks/RES-9/chat?session=${old}` })).json();
  assert.equal(alone.ended?.lost, true, 'a lost session of the board offers no «Continue»');
  const r = await post({ mode: 'board', project: 'res', keys: ['RES-9'], text: 'Do RES-9' });
  assert.equal(r.statusCode, 200, r.body);
  await until(() => entries().find((e) => e.argv?.includes(r.json().session)), 'the newer Claude to start');
  const chat = (await app.inject({ method: 'GET', url: `/api/tasks/RES-9/chat?session=${old}` })).json();
  assert.equal(chat.ended, undefined, 'the chat offered a second Claude on a task a live one works on');
});
