// The chat against a real board terminal (tmux on a private socket, a stand-in for Claude that draws a screen from a
// file and logs what is typed into it). The words of the chat go only to the board's own Claude, only from the session
// the chat shows, never ahead of words already waiting; and a question on Claude's screen reaches the chat, which has
// no terminal beside it to answer from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-chat-test-${process.pid}`;
const NEW = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'; // the board's terminal of the task
const OLD = 'ffffffff-6666-4666-8666-ffffffffffff'; // an earlier session of the same task, not the board's
let app, tmp, claude, queue, screenFile, typedFile;

const IDLE = 'Ready.\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  ? for shortcuts\n';
const BUSY = '* Working… (esc to interrupt)\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  esc to interrupt\n';
const QUESTION = ' Do you want to make this edit to a.js?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let panePid = null;
// what Claude shows, and what Claude Code's registry says of it (the board reads the registry first, as for a real one)
async function show(screen, status = 'idle') {
  writeFileSync(screenFile, screen);
  writeFileSync(join(claude, 'sessions', `${panePid}.json`), JSON.stringify({ sessionId: NEW, pid: panePid, status, updatedAt: Date.now() }));
  await pause(500); // the stand-in draws the file again every 100 ms
}
const typed = () => (existsSync(typedFile) ? readFileSync(typedFile, 'utf8') : '');
const line = (o) => `${JSON.stringify(o)}\n`;
const transcript = (words) => line({ type: 'user', timestamp: '2026-10-22T10:00:01.000Z', message: { role: 'user', content: words } })
  + line({ type: 'assistant', timestamp: '2026-10-22T10:00:02.000Z', message: { content: [{ type: 'text', text: 'On it.' }] } });

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'kb-chat-term-'));
  claude = join(tmp, 'claude');
  mkdirSync(join(claude, 'projects', '-chat'), { recursive: true });
  mkdirSync(join(claude, 'sessions'));
  writeFileSync(join(claude, 'projects', '-chat', `${NEW}.jsonl`), transcript('Do CT-1'));
  writeFileSync(join(claude, 'projects', '-chat', `${OLD}.jsonl`), transcript('Earlier work on CT-1'));
  screenFile = join(tmp, 'screen.txt');
  typedFile = join(tmp, 'typed.log');
  writeFileSync(screenFile, IDLE);
  const fake = join(tmp, 'fake-claude.cjs');
  writeFileSync(fake, `const fs = require('node:fs');
let last = null;
let buf = '';
const draw = () => { let s = ''; try { s = fs.readFileSync(${JSON.stringify(screenFile)}, 'utf8'); } catch {}
  s = s.replace(/^❯ $/m, '❯ ' + buf); // CK-733: the field shows what is typed into it, as Claude Code's does
  if (s !== last) { last = s; process.stdout.write('\\x1b[2J\\x1b[H' + s.replace(/\\n/g, '\\r\\n')); } };
setInterval(draw, 100); draw();
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h'); // bracketed paste on, as Claude Code turns it on
let paste = false;
process.stdin.on('data', (s) => {
  fs.appendFileSync(${JSON.stringify(typedFile)}, s);
  for (const part of s.split(/(\\x1b\\[20[01]~)/)) {
    if (part === '\\x1b[200~') paste = true;
    else if (part === '\\x1b[201~') paste = false;
    else if (paste) buf += part.replace(/\\n/g, ' ');
    else for (const ch of part) { if (ch === '\\r') buf = ''; else if (ch >= ' ') buf += ch; }
  }
  draw();
});
`);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_DIR: claude });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  queue = await import('../src/chat-queue.js');
  queue.setQueueDeps({ timer: false }); // the queue is not drained behind the test's back
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('ct','CT','chat terminal',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='ct'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Chat with a terminal','doing')").run(pid).lastInsertRowid;
  const tie = db.prepare('INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?,?,?,?)');
  tie.run(task, OLD, '2026-10-22 09:00:00', '2026-10-22 09:30:00');
  tie.run(task, NEW, '2026-10-22 10:00:00', '2026-10-22 10:00:02');
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(NEW);
  execFileSync(TMUX, ['-L', SOCKET, 'new-session', '-d', '-s', `kb-${NEW}`, '-x', '80', '-y', '24', process.execPath, fake]);
  panePid = Number(execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', `kb-${NEW}`, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim());
  await pause(600);
  app = Fastify();
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});

after(async () => {
  if (skip) return;
  queue?.setQueueDeps(null);
  queue?.clearQueues();
  await app?.close();
  try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server left */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_DIR']) delete process.env[k];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const look = async (q = '') => (await app.inject({ method: 'GET', url: `/api/tasks/CT-1/chat${q}` })).json();
const say = async (text) => (await app.inject({ method: 'POST', url: '/api/tasks/CT-1/chat', payload: { text } })).json();

test('the chat talks only from the session of the board\'s terminal; an earlier session of the task is read', { skip }, async () => {
  await show(IDLE);
  const now = await look();
  assert.equal(now.session, NEW);
  assert.equal(now.send, true, 'the chat of the board\'s own Claude does not take words');
  assert.equal(now.state, 'idle');
  const earlier = await look(`?session=${OLD}`);
  assert.equal(earlier.session, OLD);
  assert.equal(earlier.send, false, 'the chat of another session offers to talk — its words would reach the Claude of the terminal');
});

test('a question on the screen reaches the chat, with the lines that ask it', { skip }, async () => {
  await show(QUESTION, 'waiting');
  const r = await look();
  assert.equal(r.state, 'question');
  assert.match(r.question || '', /Do you want to make this edit to a\.js\?[\s\S]*1\. Yes[\s\S]*Esc to cancel/, 'the chat cannot see the question it has to answer');
  await show(IDLE);
  assert.equal((await look()).question, undefined, 'a question answered stays in the chat');
});

test('words never go ahead of words already waiting, even to a Claude free right now', { skip }, async () => {
  queue.clearQueues();
  await show(BUSY, 'busy');
  const first = await say('first words');
  assert.equal(first.queued, true, 'words went to a busy Claude');
  await show(IDLE);
  const second = await say('second words');
  assert.equal(second.queued, true, 'words typed into a free Claude went ahead of the ones waiting');
  assert.deepEqual(queue.queued(NEW).map((q) => q.text), ['first words', 'second words']);
  assert.equal(typed(), '', 'something was typed into the terminal');
  queue.clearQueues();
  const third = await say('third words');
  assert.equal(third.sent, true, `words to a free Claude with nothing waiting did not go at once: ${JSON.stringify(third)}`);
  await pause(500);
  assert.match(typed(), /third words/);
});

// rewind of the conversation; a Claude at rest has nothing to stop
test('Stop sends one Esc to a Claude at work, never a second one at once, nothing to a Claude at rest', { skip }, async () => {
  const stop = async () => app.inject({ method: 'POST', url: '/api/tasks/CT-1/chat/stop' });
  const { STOP_GAP_MS } = await import('../src/routes/chat.js');
  await show(IDLE, 'idle');
  writeFileSync(typedFile, '');
  const rest = await stop();
  assert.equal(rest.statusCode, 409);
  assert.equal(rest.json().reason, 'not-busy');
  await show(BUSY, 'busy');
  assert.equal((await look()).state, 'busy');
  const r = await stop();
  assert.equal(r.statusCode, 200, r.body);
  const again = await stop();
  assert.equal(again.json().reason, 'stopping', 'a second Esc went at once');
  await pause(300);
  assert.equal(typed(), '\x1b', 'not one Esc reached Claude');
  await pause(STOP_GAP_MS);
  assert.equal((await stop()).statusCode, 200, 'a stop a while later is refused');
  await show(IDLE, 'idle');
});

// a waiting message sent now leaves the queue; never over an open question, which they would answer
test('words sent now reach a Claude at work at once; a waiting message goes now too; a question holds them', { skip }, async () => {
  const post = async (url, payload) => app.inject({ method: 'POST', url, payload });
  queue.clearQueues();
  await show(BUSY, 'busy');
  await pause(2100); // words of the tests before were typed long enough ago
  writeFileSync(typedFile, '');
  const waiting = await say('later words');
  assert.equal(waiting.queued, true, JSON.stringify(waiting));
  const now = await post('/api/tasks/CT-1/chat', { text: 'right now words', now: true });
  assert.equal(now.statusCode, 200, now.body);
  assert.match(typed(), /right now words/);
  assert.doesNotMatch(typed(), /later words/, 'the waiting words went along');
  assert.equal((await post('/api/tasks/CT-1/chat', { text: 'x', now: 'yes' })).statusCode, 400);
  const item = queue.queued(NEW)[0];
  await pause(2100);
  const sent = await post(`/api/tasks/CT-1/chat/queue/${item.id}/now`);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.match(typed(), /later words/);
  assert.deepEqual(queue.queued(NEW), [], 'the words sent now stayed in the queue');
  assert.equal((await post(`/api/tasks/CT-1/chat/queue/${item.id}/now`)).statusCode, 404);
  await show(QUESTION, 'busy');
  const held = await post('/api/tasks/CT-1/chat', { text: '2 more tests', now: true });
  assert.equal(held.json().reason, 'question', 'words sent now over a question would answer it');
  await show(IDLE, 'idle');
  queue.clearQueues();
});
