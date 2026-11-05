// not — «Continue» (the board's own resume of interrupted work goes the same way) cleared the exited pane of another board
// and started the session here, «Stop» closed its live Claude, and the card typed into it. Two boards share a tmux socket
// (the sandbox had no KB_TMUX_SOCKET), and a row of this base ties their sessions to its tasks — the row an acceptance once
// left behind. Real tmux on a socket of its own; every terminal carries the port of the board that started it (KB_URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-test-foreign-${process.pid}`;
const OUR_PORT = '39671';
const THEIR_PORT = '39672';
const THEIRS_LIVE = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const THEIRS_DEAD = 'bbbbbbbb-0000-4000-8000-0000000000a2';
const NO_URL = 'cccccccc-0000-4000-8000-0000000000a3';
const OURS_LIVE = 'aaaaaaaa-0000-4000-8000-0000000000a4';
const OURS_DEAD = 'aaaaaaaa-0000-4000-8000-0000000000a5';
let tmp, folder, app, db, keys = {};

const tmux = (...args) => execFileSync(TMUX, ['-L', SOCKET, ...args]).toString();
const alive = (sid) => { try { tmux('has-session', '-t', `=kb-${sid}`); return true; } catch { return false; } };
const dead = (sid) => tmux('display-message', '-p', '-t', `=kb-${sid}:`, '#{pane_dead}').trim() === '1';
function pane(sid, port, cmd) {
  const env = port ? ['-e', `KB_URL=http://127.0.0.1:${port}`] : [];
  tmux('new-session', '-d', '-s', `kb-${sid}`, ...env, cmd);
}

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'kb-foreign-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-foreign-folder-')));
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_DIR: join(tmp, 'claude'), PORT: OUR_PORT, KB_LAUNCH_DRYRUN: '1' });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const { tieLaunched, markBoardSession } = await import('../src/claude-sessions.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('frn', 'FRN', 'Foreign', ?, 6)").run(folder).lastInsertRowid;
  // every session is tied here, and every one is «the board's own» by the base — the proof is only the port in the pane
  [THEIRS_LIVE, THEIRS_DEAD, NO_URL, OURS_LIVE, OURS_DEAD].forEach((sid, i) => {
    const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'review')").run(pid, i + 1).lastInsertRowid;
    tieLaunched(id, sid);
    markBoardSession(sid);
    keys[sid] = `FRN-${i + 1}`;
  });
  pane(THEIRS_LIVE, THEIR_PORT, 'sleep 600');
  tmux('set-option', '-g', 'remain-on-exit', 'on'); // an exited Claude leaves its pane, as phantomSpec has it
  pane(NO_URL, null, 'sleep 600');
  pane(OURS_LIVE, OUR_PORT, 'sleep 600');
  pane(THEIRS_DEAD, THEIR_PORT, 'true');
  pane(OURS_DEAD, OUR_PORT, 'true');
  for (let i = 0; i < 100 && !(dead(THEIRS_DEAD) && dead(OURS_DEAD)); i += 1) await new Promise((r) => { setTimeout(r, 50); });
  assert.ok(dead(THEIRS_DEAD) && dead(OURS_DEAD) && !dead(THEIRS_LIVE), 'the stand: the exited panes are not dead, or the live one is');
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});

after(async () => {
  if (skip) return;
  await app?.close();
  try { tmux('kill-server'); } catch { /* no server left */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_DIR', 'PORT', 'KB_LAUNCH_DRYRUN']) delete process.env[k];
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

const inject = (method, url, payload) => app.inject({ method, url, payload });

test('«Stop» closes only a terminal this board started: another board\'s or nobody\'s is refused and left running', { skip }, async () => {
  const r = await inject('DELETE', `/api/tasks/${keys[THEIRS_LIVE]}/terminal`);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().reason, 'other-board');
  assert.equal(r.json().port, Number(THEIR_PORT), 'the refusal does not name the board that started it');
  assert.ok(alive(THEIRS_LIVE) && !dead(THEIRS_LIVE), '«Stop» closed a live Claude another board started');
  const none = await inject('DELETE', `/api/tasks/${keys[NO_URL]}/terminal`);
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(none.json().reason, 'other-board');
  assert.ok(alive(NO_URL), '«Stop» closed a terminal no board says is its own');
  const ours = await inject('DELETE', `/api/tasks/${keys[OURS_LIVE]}/terminal`);
  assert.equal(ours.statusCode, 200, ours.body);
  for (let i = 0; i < 60 && alive(OURS_LIVE); i += 1) await new Promise((r2) => { setTimeout(r2, 50); });
  assert.ok(!alive(OURS_LIVE), '«Stop» did not close a terminal of this very board');
});

test('the card types into another board\'s Claude nowhere — not its answer, not a message', { skip }, async () => {
  const typed = await inject('POST', `/api/tasks/${keys[THEIRS_LIVE]}/terminal`, { text: 'yes' });
  assert.equal(typed.statusCode, 409, typed.body);
  assert.equal(typed.json().reason, 'other-board');
  const msg = await inject('POST', `/api/tasks/${keys[THEIRS_LIVE]}/terminal/message`, { text: 'hello' });
  assert.equal(msg.statusCode, 409, msg.body);
  assert.equal(msg.json().reason, 'other-board');
  // the chat of the card — the one a phone shows — goes the same way: its words and its «Stop»
  for (const [url, body] of [['chat', { text: 'hello' }], ['chat/stop', {}]]) {
    const r = await inject('POST', `/api/tasks/${keys[THEIRS_LIVE]}/${url}`, body);
    assert.equal(r.statusCode, 409, `${url}: ${r.body}`);
    assert.equal(r.json().reason, 'other-board', `the chat's ${url} reached another board's Claude`);
  }
  // looking is allowed; laying its window out for this card is not
  const width = () => tmux('display-message', '-p', '-t', `=kb-${THEIRS_LIVE}:`, '#{window_width}').trim();
  const was = width();
  const look = await inject('GET', `/api/tasks/${keys[THEIRS_LIVE]}/terminal?cols=${Number(was) === 30 ? 31 : 30}`);
  assert.equal(look.statusCode, 200, look.body);
  assert.equal(width(), was, 'a look from this board laid out the window of another board\'s Claude');
  const { otherBoard } = await import('../src/phantom.js');
  assert.deepEqual(await otherBoard('ffffffff-0000-4000-8000-0000000000ff'), { port: null }, 'a pane tmux did not say about read as this board\'s');
  const { refusalText } = await import('../public/js/unsaved.js');
  const said = refusalText(Object.assign(new Error(typed.json().error), { status: 409, body: typed.json() }));
  assert.match(said.reason, /started by another board/, 'the page says the refusal as «the board did not accept it»');
});

test('«Continue» does not clear the exited pane of another board to start its session here — by hand or by the board', { skip }, async () => {
  const { ADOPT_TOKEN } = await import('../src/claude-sessions.js');
  for (const extra of [{}, { adopt: ADOPT_TOKEN }]) {
    const r = await inject('POST', '/api/launch', { mode: 'board', resume: THEIRS_DEAD, project: 'frn', keys: [keys[THEIRS_DEAD]], ...extra });
    assert.equal(r.statusCode, 409, `${JSON.stringify(extra)}: ${r.body}`);
    assert.equal(r.json().reason, 'other-board');
    assert.ok(alive(THEIRS_DEAD), '«Continue» closed the pane of another board');
    assert.ok(dead(THEIRS_DEAD), `«Continue» started a Claude in the pane of another board: ${tmux('display-message', '-p', '-t', `=kb-${THEIRS_DEAD}:`, '#{pane_dead} #{pane_current_command}')}`);
  }
  const ours = await inject('POST', '/api/launch', { mode: 'board', resume: OURS_DEAD, project: 'frn', keys: [keys[OURS_DEAD]] });
  assert.equal(ours.statusCode, 200, `«Continue» of this board's own exited Claude was refused: ${ours.body}`);
  assert.equal(ours.json().resumed, true);
});

// The panes here run `sleep`: no registry, nothing on the screen, so each reads as a Claude at its prompt
test('the room the fix of an automation makes never closes another board\'s or nobody\'s terminal', { skip }, async () => {
  const { ADOPT_TOKEN } = await import('../src/claude-sessions.js');
  const { setLookHold } = await import('../src/phantom.js');
  setLookHold(0); // a look of an earlier test does not hold the terminal: only the port decides
  for (const sid of [THEIRS_LIVE, NO_URL]) {
    const r = await inject('POST', '/api/launch', { mode: 'board', text: 'go', project: 'frn', keys: [keys[sid]], makeRoom: ADOPT_TOKEN });
    assert.equal(r.statusCode, 409, `${sid}: ${r.body}`);
    assert.ok(alive(sid) && !dead(sid), `the room of a fix closed ${sid === NO_URL ? 'a terminal no board says is its own' : 'a live Claude another board started'}`);
  }
});

test('the room the fix of an automation makes does close this board\'s own Claude at its prompt', { skip }, async () => {
  const { ADOPT_TOKEN } = await import('../src/claude-sessions.js');
  const { setLookHold } = await import('../src/phantom.js');
  setLookHold(0);
  const sid = 'aaaaaaaa-0000-4000-8000-0000000000a6';
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'frn'").get().id;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 6, 'T', 'review')").run(pid).lastInsertRowid;
  const { tieLaunched, markBoardSession } = await import('../src/claude-sessions.js');
  tieLaunched(id, sid);
  markBoardSession(sid);
  pane(sid, OUR_PORT, 'sleep 600');
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'go', project: 'frn', keys: ['FRN-6'], makeRoom: ADOPT_TOKEN });
  assert.equal(r.statusCode, 200, `the stand: a fix found no room by this board's own resting Claude: ${r.body}`);
  assert.ok(!alive(sid), 'the room of a fix left this board\'s own resting Claude');
});
