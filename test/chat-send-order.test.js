// Words of the chat typed into the board's own Claude (POST /api/tasks/:id/chat) against a real board terminal: tmux on a
// private socket and a stand-in for Claude that draws a screen from a file and logs what is typed into it.
// Two messages sent at once to a free Claude must not reach it as one (text1 text2 Enter Enter): the first is typed,
// the second waits in the queue. And words that would switch Claude Code into a mode (`/`, `!`, `#`) go after the task's
// key — the chat has no input line to show the person what such a start would do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-chat-send-${process.pid}`;
const SID = 'cafecafe-8888-4888-8888-cafecafecafe';
let app, tmp, claude, queue, screenFile, typedFile, panePid;

const IDLE = 'Ready.\n\n────────────────────────────────\n❯ \n────────────────────────────────\n  ? for shortcuts\n';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const typed = () => (existsSync(typedFile) ? readFileSync(typedFile, 'utf8') : '');
const line = (o) => `${JSON.stringify(o)}\n`;

before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'kb-chat-send-'));
  claude = join(tmp, 'claude');
  mkdirSync(join(claude, 'projects', '-send'), { recursive: true });
  mkdirSync(join(claude, 'sessions'));
  writeFileSync(join(claude, 'projects', '-send', `${SID}.jsonl`), line({ type: 'user', timestamp: '2026-10-22T12:00:01.000Z', message: { role: 'user', content: 'Do CS-1' } }));
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
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('cs','CS','chat send',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='cs'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Chat send','doing')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?,?,?,?)').run(task, SID, '2026-10-22 12:00:00', '2026-10-22 12:00:01');
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(SID);
  execFileSync(TMUX, ['-L', SOCKET, 'new-session', '-d', '-s', `kb-${SID}`, '-x', '80', '-y', '24', process.execPath, fake]);
  panePid = Number(execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', `kb-${SID}`, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim());
  // Claude Code's registry says the Claude of the pane waits at its prompt; the screen stays as it is
  writeFileSync(join(claude, 'sessions', `${panePid}.json`), JSON.stringify({ sessionId: SID, pid: panePid, status: 'idle', updatedAt: Date.now() }));
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

const say = async (text) => (await app.inject({ method: 'POST', url: '/api/tasks/CS-1/chat', payload: { text } })).json();

test('two messages sent at once to a free Claude: the first is typed, the second waits in the queue', { skip }, async () => {
  queue.clearQueues();
  writeFileSync(typedFile, '');
  const [a, b] = await Promise.all([say('alpha words'), say('beta words')]);
  const sent = [a, b].filter((r) => r.sent);
  const waiting = [a, b].filter((r) => r.queued);
  assert.equal(sent.length, 1, `both messages were typed into Claude at once: ${JSON.stringify([a, b])}`);
  assert.equal(waiting.length, 1);
  await pause(600);
  const out = typed();
  assert.ok(!(out.includes('alpha words') && out.includes('beta words')), `both reached the terminal: ${JSON.stringify(out)}`);
  // and right after words went, the next ones wait too — Claude has not shown it is busy with the first yet
  assert.equal(queue.unqueue(SID, waiting[0].id), true); // the queue emptied, not the memory of words just typed
  const next = await say('gamma words');
  assert.equal(next.queued, true, `words right after words were typed at once: ${JSON.stringify(next)}`);
  queue.clearQueues();
});

test('words of the chat that would switch Claude Code into a mode reach it after the task\'s key', { skip }, async () => {
  queue.clearQueues();
  await pause(2100); // the words of the test before have been typed long enough ago
  writeFileSync(typedFile, '');
  const r = await say('/clear');
  assert.equal(r.sent, true, JSON.stringify(r));
  await pause(600);
  assert.match(typed(), /CS-1: \/clear/, `a slash command from the chat reached Claude as one: ${JSON.stringify(typed())}`);
  queue.clearQueues();
});
