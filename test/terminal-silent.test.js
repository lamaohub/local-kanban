// KB_URL with its port, and the board asks tmux for it (show-environment) before it types, closes or takes one in. A tmux
// that does not answer that is neither «this board's» nor «another board's»: nothing is typed or closed, and nothing the
// person said is lost — the queue of the chat spent its tries on it and threw the owner's words away. And another board's
// terminal is said so on the page before anything is pressed. Real tmux on a socket of its own; a `tmux` first on PATH
// fails show-environment while the file SILENT is there, as a stalled tmux does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-test-silent-${process.pid}`;
const OUR_PORT = '39681';
const THEIR_PORT = '39682';
const OURS = 'aaaaaaaa-1111-4000-8000-0000000000c1';        // this board's Claude, its task in work
const THEIRS = 'bbbbbbbb-1111-4000-8000-0000000000c2';      // another board's Claude, its task in Review
const THEIRS_DONE = 'bbbbbbbb-1111-4000-8000-0000000000c3'; // another board's, its task accepted
const OURS_TIED = 'aaaaaaaa-1111-4000-8000-0000000000c4';   // this board's, tied, not taken in yet (a start takes it in)
const THEIRS_DEAD = 'bbbbbbbb-1111-4000-8000-0000000000c5'; // another board's, exited, its task accepted
const THEIRS_REST = 'bbbbbbbb-1111-4000-8000-0000000000c6'; // another board's, resting at its prompt, its task in Review
const IDLE = 'Ready.\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  ? for shortcuts\n';
const BUSY = '* Working… (esc to interrupt)\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  esc to interrupt\n';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
let tmp, claude, app, db, phantom, queue, silentFlag, keys = {}, pids = {};

const tmux = (...args) => execFileSync(TMUX, ['-L', SOCKET, ...args]).toString();
const alive = (sid) => { try { tmux('has-session', '-t', `=kb-${sid}`); return true; } catch { return false; } };
const dead = (sid) => tmux('display-message', '-p', '-t', `=kb-${sid}:`, '#{pane_dead}').trim() === '1';
const width = (sid) => Number(tmux('display-message', '-p', '-t', `=kb-${sid}:`, '#{window_width}').trim());
const screenFile = (sid) => join(tmp, `${sid}.screen`);
const typedFile = (sid) => join(tmp, `${sid}.typed`);
const typed = (sid) => (existsSync(typedFile(sid)) ? readFileSync(typedFile(sid), 'utf8') : '');
const silent = (on) => { if (on) writeFileSync(silentFlag, ''); else rmSync(silentFlag, { force: true }); };
const line = (o) => `${JSON.stringify(o)}\n`;
// what a stand-in of Claude shows, and what Claude Code's registry says of it
async function show(sid, screen, status = 'idle') {
  writeFileSync(screenFile(sid), screen);
  writeFileSync(join(claude, 'sessions', `${pids[sid]}.json`), JSON.stringify({ sessionId: sid, pid: pids[sid], status, updatedAt: Date.now() }));
  await pause(400); // the stand-in draws the file again every 100 ms
}
// the stand-in of Claude Code of test/chat-board-terminal.test.js: draws SCREEN, its field shows what is typed, logs to TYPED
const FAKE = `const fs = require('node:fs');
let last = null;
let buf = '';
const draw = () => { let s = ''; try { s = fs.readFileSync(process.env.SCREEN, 'utf8'); } catch {}
  s = s.replace(/^❯ $/m, '❯ ' + buf);
  if (s !== last) { last = s; process.stdout.write('\\x1b[2J\\x1b[H' + s.replace(/\\n/g, '\\r\\n')); } };
setInterval(draw, 100); draw();
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
let paste = false;
process.stdin.on('data', (s) => {
  fs.appendFileSync(process.env.TYPED, s);
  for (const part of s.split(/(\\x1b\\[20[01]~)/)) {
    if (part === '\\x1b[200~') paste = true;
    else if (part === '\\x1b[201~') paste = false;
    else if (paste) buf += part.replace(/\\n/g, ' ');
    else for (const ch of part) { if (ch === '\\r') buf = ''; else if (ch >= ' ') buf += ch; }
  }
  draw();
});
`;

function pane(sid, port, cmd) {
  const env = [...(port ? ['-e', `KB_URL=http://127.0.0.1:${port}`] : []), '-e', `SCREEN=${screenFile(sid)}`, '-e', `TYPED=${typedFile(sid)}`];
  tmux('new-session', '-d', '-s', `kb-${sid}`, '-x', '80', '-y', '24', ...env, ...cmd);
  pids[sid] = Number(tmux('list-panes', '-t', `=kb-${sid}`, '-F', '#{pane_pid}').trim());
}

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'kb-silent-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-silent-folder-')));
  claude = join(tmp, 'claude');
  mkdirSync(join(claude, 'projects', '-silent'), { recursive: true });
  mkdirSync(join(claude, 'sessions'));
  // the tmux of the board: the real one, but show-environment fails while SILENT is there
  silentFlag = join(tmp, 'SILENT');
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(join(tmp, 'bin', 'tmux'), `#!/bin/sh\nif [ -f '${silentFlag}' ]; then for a in "$@"; do [ "$a" = show-environment ] && { echo 'server exited unexpectedly' >&2; exit 1; }; done; fi\nexec '${TMUX}' "$@"\n`);
  chmodSync(join(tmp, 'bin', 'tmux'), 0o755);
  Object.assign(process.env, {
    KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_DIR: claude, PORT: OUR_PORT, KB_LAUNCH_DRYRUN: '1', PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
  });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  phantom = await import('../src/phantom.js');
  assert.equal(phantom.tmuxBin(), join(tmp, 'bin', 'tmux'), 'the stand: the board does not run the tmux of the test');
  queue = await import('../src/chat-queue.js');
  queue.setQueueDeps({ timer: false }); // the test ticks the queue itself
  const { tieLaunched, markBoardSession } = await import('../src/claude-sessions.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sil', 'SIL', 'Silent', ?, 7)").run(folder).lastInsertRowid;
  const stands = [[OURS, 'doing', true], [THEIRS, 'review', true], [THEIRS_DONE, 'done', true], [OURS_TIED, 'done', false], [THEIRS_DEAD, 'done', true], [THEIRS_REST, 'review', true]];
  stands.forEach(([sid, status, board], i) => {
    const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', ?)").run(pid, i + 1, status).lastInsertRowid;
    tieLaunched(id, sid);
    if (board) markBoardSession(sid); // a row of this base — no proof of whose the terminal is
    keys[sid] = `SIL-${i + 1}`;
    writeFileSync(join(claude, 'projects', '-silent', `${sid}.jsonl`), line({ type: 'user', timestamp: '2026-11-07T10:00:01.000Z', message: { role: 'user', content: `Do SIL-${i + 1}` } })
      + line({ type: 'assistant', timestamp: '2026-11-07T10:00:02.000Z', message: { content: [{ type: 'text', text: 'On it.' }] } }));
  });
  const fake = join(tmp, 'fake-claude.cjs');
  writeFileSync(fake, FAKE);
  for (const sid of [OURS, THEIRS]) writeFileSync(screenFile(sid), IDLE);
  pane(OURS, OUR_PORT, [process.execPath, fake]);
  pane(THEIRS, THEIR_PORT, [process.execPath, fake]);
  pane(THEIRS_DONE, THEIR_PORT, ['sleep', '600']);
  pane(OURS_TIED, OUR_PORT, ['sleep', '600']);
  pane(THEIRS_REST, THEIR_PORT, ['sleep', '600']);
  tmux('set-option', '-g', 'remain-on-exit', 'on'); // an exited Claude leaves its pane, as phantomSpec has it
  pane(THEIRS_DEAD, THEIR_PORT, ['true']);
  for (let i = 0; i < 100 && !dead(THEIRS_DEAD); i += 1) await pause(50);
  assert.ok(dead(THEIRS_DEAD), 'the stand: the exited pane is not dead');
  await show(OURS, IDLE);
  await show(THEIRS, IDLE);
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});

after(async () => {
  if (skip) return;
  silent(false);
  queue?.setQueueDeps(null);
  queue?.clearQueues();
  await app?.close();
  try { tmux('kill-server'); } catch { /* no server left */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_DIR', 'PORT', 'KB_LAUNCH_DRYRUN']) delete process.env[k];
  process.env.PATH = process.env.PATH.split(':').filter((d) => d !== join(tmp, 'bin')).join(':');
  rmSync(tmp, { recursive: true, force: true });
});

const inject = (method, url, payload) => app.inject({ method, url, payload });
const task = { id: 0, key: 'SIL-9', status: 'doing', labels: '[]' };

// The panes are looked at in an order: a look of the card keeps whose a pane is for a minute (by the pane), and a look
// before the silence would answer for it. The silent tests come first, on panes nothing has asked about yet.

test('a silent tmux: the board types nothing into its own Claude, and says tmux is slow — not «another board»', { skip }, async () => {
  silent(true);
  try {
    const { sayToTerminal } = await import('../src/terminal-say.js');
    assert.deepEqual(await sayToTerminal(task, OURS, { text: 'zzsilentkeys', key: 'Enter' }), { refused: 'tmux-slow' },
      'a tmux that did not say whose the terminal is was taken for another board: the board\'s own Claude would never be told to go on');
    assert.deepEqual(await sayToTerminal(task, OURS, { text: 'zzsilentchat', key: 'Enter', chat: true }), { refused: 'tmux-slow' });
    await pause(300);
    assert.doesNotMatch(typed(OURS), /zzsilent/, 'the board typed into a terminal tmux did not say is its own');
  } finally { silent(false); }
});

test('a silent tmux leaves the chat and the Terminal tab of the board\'s own Claude as they are: a field, a hold, a width', { skip }, async () => {
  const { termControls, otherBoardLine } = await import('../public/js/term-owner-rules.js');
  silent(true);
  try {
    const chat = await inject('GET', `/api/tasks/${keys[OURS]}/chat`);
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(chat.json().send, true, 'a silent tmux made the chat of the board\'s own Claude read-only');
    assert.equal(chat.json().other, undefined, 'the chat says another board started the board\'s own terminal');
    assert.equal(phantom.lookedLately(OURS), false, 'the stand: the terminal was looked at before');
    const was = width(OURS);
    const look = await inject('GET', `/api/tasks/${keys[OURS]}/terminal?cols=${was - 20}`);
    assert.equal(look.statusCode, 200, look.body);
    assert.deepEqual(look.json().other, { port: null, silent: true });
    assert.equal(phantom.lookedLately(OURS), true, 'a look under a silent tmux did not hold the board\'s own terminal: a pass may close it under the person\'s eyes');
    assert.notEqual(width(OURS), was, 'a look under a silent tmux did not lay out the board\'s own window for the card');
    // the page's own rule on the real answer: the field, «Stop» and the notes stay
    assert.deepEqual(termControls(look.json()), { field: true, stop: true, resume: false, notes: true, other: false });
    assert.equal(otherBoardLine(look.json()), '');
    // an action at this moment is refused as a slow tmux, said so
    const said = await inject('POST', `/api/tasks/${keys[OURS]}/chat`, { text: 'hello' });
    assert.equal(said.statusCode, 409, said.body);
    assert.equal(said.json().reason, 'tmux-slow');
  } finally { silent(false); }
});

test('a silent tmux: no pass, no start of the board and no room for a fix closes or takes in a terminal', { skip }, async () => {
  phantom.setLookHold(0); // only whose the terminal is decides
  silent(true);
  try {
    assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a pass under a silent tmux closed a terminal');
    assert.ok(alive(THEIRS_DONE), 'a pass under a silent tmux closed another board\'s terminal of an accepted task');
    assert.equal(await phantom.adoptBoardTerminals(), 0, 'a start under a silent tmux took in a terminal no one said is its own');
    assert.equal(db.prepare('SELECT 1 FROM board_sessions WHERE session_id = ?').get(OURS_TIED), undefined);
    const { ADOPT_TOKEN } = await import('../src/claude-sessions.js');
    const r = await inject('POST', '/api/launch', { mode: 'board', text: 'go', project: 'sil', keys: [keys[THEIRS_REST]], makeRoom: ADOPT_TOKEN });
    assert.equal(r.statusCode, 409, r.body);
    assert.ok(alive(THEIRS_REST) && !dead(THEIRS_REST), 'the room of a fix under a silent tmux closed another board\'s Claude at its prompt');
  } finally { silent(false); phantom.setLookHold(phantom.LOOK_HOLD_MS); }
});

test('a pass closes no exited terminal of another board, though its task is accepted', { skip }, async () => {
  phantom.setLookHold(0);
  try {
    await phantom.closeFinishedTerminals();
    assert.ok(alive(THEIRS_DEAD), 'a pass closed the exited pane of another board — its last screen and its «Continue» there');
    assert.ok(alive(THEIRS_DONE), 'a pass closed another board\'s terminal of an accepted task');
  } finally { phantom.setLookHold(phantom.LOOK_HOLD_MS); }
});

test('another board\'s terminal: the chat and the Terminal tab say so before anything is pressed, and offer nothing to press', { skip }, async () => {
  const { termControls, otherBoardLine } = await import('../public/js/term-owner-rules.js');
  const tr = (s) => `ru:${s}`; // a forgotten translation shows
  const chat = await inject('GET', `/api/tasks/${keys[THEIRS]}/chat`);
  assert.equal(chat.statusCode, 200, chat.body);
  assert.equal(chat.json().send, false, 'the chat of another board\'s Claude takes words');
  assert.deepEqual(chat.json().other, { port: Number(THEIR_PORT) }, 'the chat does not tell the page whose the terminal is');
  assert.equal(otherBoardLine(chat.json(), tr), `ru:This terminal was started by another board — manage it there: port ${THEIR_PORT}`);
  const look = await inject('GET', `/api/tasks/${keys[THEIRS]}/terminal?cols=40`);
  assert.equal(look.statusCode, 200, look.body);
  assert.deepEqual(look.json().other, { port: Number(THEIR_PORT) });
  assert.equal(phantom.lookedLately(THEIRS), false, 'a look of this board holds another board\'s terminal from its own pass');
  assert.deepEqual(termControls(look.json()), { field: false, stop: false, resume: false, notes: false, other: true });
  // exited: no «Continue» — not in the chat, not in the tab
  const ended = await inject('GET', `/api/tasks/${keys[THEIRS_DEAD]}/chat`);
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().ended, undefined, 'the chat offers «Continue» in another board\'s terminal');
  assert.deepEqual(ended.json().other, { port: Number(THEIR_PORT) });
  const deadLook = await inject('GET', `/api/tasks/${keys[THEIRS_DEAD]}/terminal`);
  assert.equal(deadLook.json().dead, true, deadLook.body);
  assert.deepEqual(termControls(deadLook.json()), { field: false, stop: false, resume: false, notes: false, other: true });
});

test('queued words wait out a silent tmux at the head of the queue, and go once it answers — exactly once', { skip }, async () => {
  queue.clearQueues();
  await show(OURS, BUSY, 'busy');
  writeFileSync(typedFile(OURS), '');
  const q = await inject('POST', `/api/tasks/${keys[OURS]}/chat`, { text: 'zzqueuedwords' });
  assert.equal(q.json().queued, true, q.body);
  silent(true);
  await show(OURS, IDLE, 'idle');
  let now = Date.now();
  const tick = async () => { now += 2100; await queue.queueTick(now); };
  try {
    for (let i = 0; i < 2 * queue.DELIVER_TRIES + 2; i += 1) await tick(); // a try at every second tick: more than all the tries
    assert.deepEqual(queue.queued(OURS).map((x) => x.text), ['zzqueuedwords'], 'a silent tmux threw the person\'s words out of the queue');
    assert.doesNotMatch(typed(OURS), /zzqueuedwords/, 'words went into a terminal tmux did not say is the board\'s own');
  } finally { silent(false); }
  for (let i = 0; i < 6 && queue.queued(OURS).length; i += 1) await tick();
  for (let i = 0; i < 4; i += 1) await tick(); // nothing more goes
  await pause(300);
  assert.deepEqual(queue.queued(OURS), [], 'the words did not go once tmux answered');
  assert.equal(typed(OURS).split('zzqueuedwords').length - 1, 1, `the words went not once: ${JSON.stringify(typed(OURS))}`);
});

test('words of the chat refused before typing are said as every refusal of such a terminal, not as a code', { skip }, async () => {
  const { notDelivered } = await import('../src/routes/chat.js');
  const { TMUX_SLOW } = phantom;
  assert.deepEqual(notDelivered({ refused: 'tmux-slow' }), { error: TMUX_SLOW, reason: 'tmux-slow' });
  const other = notDelivered({ refused: 'other-board', port: 3922 });
  assert.equal(other.reason, 'other-board');
  assert.equal(other.port, 3922);
  assert.match(other.error, /another board \(port 3922\)/);
  // for real: the look of the card knows the pane (kept a minute), the typing asks tmux again — and tmux is silent
  await pause(2100); // the words of the test before were typed long enough ago
  assert.equal((await inject('GET', `/api/tasks/${keys[OURS]}/terminal`)).statusCode, 200);
  silent(true);
  try {
    const r = await inject('POST', `/api/tasks/${keys[OURS]}/chat`, { text: 'zznowwords', now: true });
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(r.json(), { error: TMUX_SLOW, reason: 'tmux-slow' });
  } finally { silent(false); }
  assert.doesNotMatch(typed(OURS), /zznowwords/);
});

test('queued words another board\'s terminal refuses go to the error log at once, not tried again and again', { skip }, async () => {
  queue.clearQueues();
  let said = 0;
  queue.setQueueDeps({ timer: false, atPrompt: async () => 'idle', say: async () => { said += 1; return { refused: 'other-board', port: 3922 }; } });
  try {
    queue.enqueue(OURS, db.prepare("SELECT id FROM tasks WHERE task_no = 1").get().id, 'zzotherwords');
    let now = Date.now();
    for (let i = 0; i < 2 * queue.DELIVER_TRIES + 2; i += 1) { now += 2100; await queue.queueTick(now); }
    assert.equal(said, 1, 'words another board\'s terminal refused were tried again');
    assert.deepEqual(queue.queued(OURS), []);
    const logged = db.prepare("SELECT message FROM app_errors WHERE message LIKE 'queued words were not typed%' ORDER BY id DESC").get();
    assert.match(logged?.message || '', /another board \(port 3922\)/, 'the error log does not say where the words went');
  } finally { queue.setQueueDeps({ timer: false }); }
});
