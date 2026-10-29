// (tmux on a private socket, a stand-in for Claude that draws a screen from a file, shows what is typed into its field and
// logs every byte). Breaks that left the rest of the suite green: «now» and «stop» past the lock of typing (two «now» glued
// into one message, three stops — three Esc, Claude Code's rewind), a refused «now» of the queue not back at its head, a
// refusal answered 200 — and the queue typing its words at once after words sent «now».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-chat-now-${process.pid}`;
const NEW = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'; // the board's terminal of the task
const OLD = 'ffffffff-6666-4666-8666-ffffffffffff'; // an earlier session of the same task, not the board's
let app, tmp, claude, queue, screenFile, typedFile, lagFile;

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
  lagFile = join(tmp, 'lag'); // while it exists, the stand-in shows a paste in its field only after a moment
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
const pasted = (s) => { if (fs.existsSync(${JSON.stringify(lagFile)})) setTimeout(() => { buf += s; draw(); }, 400); else buf += s; };
process.stdin.on('data', (s) => {
  fs.appendFileSync(${JSON.stringify(typedFile)}, s);
  for (const part of s.split(/(\\x1b\\[20[01]~)/)) {
    if (part === '\\x1b[200~') paste = true;
    else if (part === '\\x1b[201~') paste = false;
    else if (paste) pasted(part.replace(/\\n/g, ' '));
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

const post = async (url, payload) => app.inject({ method: 'POST', url, payload });
const typedSince = (n) => typed().slice(n);
let taskId;
const vis = (s) => s.replace(/\x1b\[200~/g, '<P>').replace(/\x1b\[201~/g, '</P>').replace(/\x0b/g, '^K').replace(/\x15/g, '^U').replace(/\r/g, '<CR>').replace(/\x1b/g, '<ESC>');

test('«now» over an open question (no field drawn) — 409 question, not one byte typed; queued-now keeps its place', { skip }, async () => {
  const { db } = await import('../src/db.js');
  taskId = db.prepare("SELECT id FROM tasks WHERE task_no=1").get().id;
  queue.clearQueues();
  await show(QUESTION, 'busy');
  await pause(2100);
  const n0 = typed().length;
  const r = await post('/api/tasks/CT-1/chat', { text: 'answer-it-not', now: true });
  queue.enqueue(NEW, taskId, 'first waiting');
  const b = queue.enqueue(NEW, taskId, 'second waiting');
  const r2 = await post(`/api/tasks/CT-1/chat/queue/${b.id}/now`);
  assert.equal(r.statusCode, 409); assert.equal(r.json().reason, 'question');
  assert.equal(r2.statusCode, 409);
  assert.deepEqual(queue.queued(NEW).map((x) => x.text), ['second waiting', 'first waiting'], 'words were lost under a question');
  assert.equal(typedSince(n0), '', 'bytes went to a question');
  queue.clearQueues();
});

// form of a question — not only as the tail of the screen
test('a question on the screen comes to the chat as a choice: its text and its options', { skip }, async () => {
  await show(QUESTION, 'busy');
  const d = await look();
  assert.equal(d.state, 'question');
  assert.equal(d.choice?.text, 'Do you want to make this edit to a.js?');
  assert.deepEqual(d.choice.options.map((o) => [o.n, o.label]), [[1, 'Yes'], [2, 'No']]);
  assert.ok(d.question, 'the tail of the screen is gone — the chat has nothing to fall back on');
  // under a label that ends near the edge (by the width alone it was taken for the label's own wrap)
  const label = 'Keep the steps where they are now, exactly as they stand (Recommended)';
  await show(`${'─'.repeat(80)}\n│ Where should the steps open?\n\n ❯ \x1b[2m1.\x1b[22m ${label}\n      \x1b[2mClaude scrolls the chat by itself\x1b[22m\n   \x1b[2m2.\x1b[22m Open them in view\n\n Enter to select · Esc to cancel\n`, 'busy');
  const f = await look();
  assert.deepEqual(f.choice?.options.map((o) => [o.label, o.note]), [[label, 'Claude scrolls the chat by itself'], ['Open them in view', '']]);
  assert.ok(!f.question.includes('\x1b'), 'the tail of the screen carries its escapes');
  await show(BUSY, 'busy');
  assert.equal((await look()).choice, undefined, 'a choice over a Claude at work');
});

test('the registry says waiting (a question), a field IS drawn — now must still type nothing', { skip }, async () => {
  await show(BUSY, 'waiting');
  const st = (await look()).state;
  const n0 = typed().length;
  const r = await post('/api/tasks/CT-1/chat', { text: 'over-a-waiting', now: true });
  assert.equal(typedSince(n0), '', 'bytes went to a Claude that waits on a question');
});

test('two «now» at once — two separate messages, never glued', { skip }, async () => {
  await show(BUSY, 'busy');
  await pause(300);
  const n0 = typed().length;
  const [x, y] = await Promise.all([post('/api/tasks/CT-1/chat', { text: 'alpha words', now: true }), post('/api/tasks/CT-1/chat', { text: 'beta words', now: true })]);
  const t = vis(typedSince(n0));
  assert.equal(x.statusCode, 200); assert.equal(y.statusCode, 200);
  assert.match(t, /alpha words<\/P><CR>.*beta words<\/P><CR>|beta words<\/P><CR>.*alpha words<\/P><CR>/);
});

test('stop while words are being delivered — the Esc waits until the words went (Enter), never in their middle', { skip }, async () => {
  await show(BUSY, 'busy');
  await pause(1600);
  const n0 = typed().length;
  // the lock first on a loaded machine (each request asks tmux for the task's terminal before the lock), and its Esc
  // went first, as it should. The stand-in shows the paste in its field only after a moment: the stop surely comes
  // before the words' Enter, and a stop past the lock is caught every time
  writeFileSync(lagFile, '');
  let s, st;
  try {
    const sending = post('/api/tasks/CT-1/chat', { text: 'gamma words', now: true });
    for (let i = 0; i < 500 && !typedSince(n0).includes('gamma words'); i++) await pause(10);
    [s, st] = await Promise.all([sending, post('/api/tasks/CT-1/chat/stop')]);
  } finally { rmSync(lagFile, { force: true }); }
  assert.equal(s.statusCode, 200, `the words were not delivered: ${s.body}`);
  assert.equal(st.statusCode, 200, `the stop was refused: ${st.body}`);
  const t = vis(typedSince(n0));
  const sent = t.indexOf('gamma words</P><CR>');
  assert.ok(sent >= 0 && t.indexOf('<ESC>') > sent, `Esc came before the words were sent: ${t}`);
});

test('two stops at once (two tabs) — exactly one Esc', { skip }, async () => {
  await show(BUSY, 'busy');
  await pause(1600);
  const n0 = typed().length;
  const rs = await Promise.all([post('/api/tasks/CT-1/chat/stop'), post('/api/tasks/CT-1/chat/stop'), post('/api/tasks/CT-1/chat/stop')]);
  await pause(300);
  const t = vis(typedSince(n0));
  assert.equal((t.match(/<ESC>/g) || []).length, 1);
});

test('words that never show in the field — 409 not-typed with the board\'s words, no Enter; queued-now goes back to the head', { skip }, async () => {
  const STALE = 'Ready.\n\n────────────────────────────────\n❯ left over\n────────────────────────────────\n  ? for shortcuts\n';
  await show(STALE, 'idle');
  await pause(2100);
  queue.clearQueues();
  const n0 = typed().length;
  const r = await post('/api/tasks/CT-1/chat', { text: 'delta words' });
  const t = vis(typedSince(n0));
  assert.equal(r.statusCode, 409, 'a refusal of delivery answered as sent'); assert.equal(r.json().reason, 'not-typed');
  assert.ok(!t.includes('<CR>'), 'Enter went with words not in the field');
  await show(STALE, 'busy');
  await pause(2100);
  queue.enqueue(NEW, taskId, 'q-one');
  const b = queue.enqueue(NEW, taskId, 'q-two');
  const r2 = await post(`/api/tasks/CT-1/chat/queue/${b.id}/now`);
  assert.deepEqual(queue.queued(NEW).map((x) => x.text), ['q-two', 'q-one'], 'not back at the head');
  queue.clearQueues();
});

test('«now» and the queue\'s tick at once — the queued words still wait their two seconds after the now-words', { skip }, async () => {
  await show(IDLE, 'idle');
  await pause(2100);
  queue.clearQueues();
  let viol = 0;
  for (let i = 0; i < 3; i++) {
    queue.clearQueues();
    await pause(2100);
    const n0 = typed().length;
    queue.enqueue(NEW, taskId, `queued-${i}`);
    await queue.queueTick(Date.now() - 3000); // seen idle since 3 s ago
    const tick = queue.queueTick(Date.now());
    const now = post('/api/tasks/CT-1/chat', { text: `nowword-${i}`, now: true });
    await Promise.all([tick, now]);
    const t = vis(typedSince(n0));
    const iq = t.indexOf(`queued-${i}`); const inw = t.indexOf(`nowword-${i}`);
    if (iq >= 0 && inw >= 0 && iq > inw) viol++;
  }
  queue.clearQueues();
  assert.equal(viol, 0, 'the queue typed its words at once after words sent «now»');
});

// The same acceptance: a picture of the chat went to Claude in the tests only through the queue — dropped by «now» or by
// the words typed at once, the suite stayed green. Its path is pasted on its own, before the words
test('a picture goes with words typed at once and with words sent «now»: its path pasted on its own, first', { skip }, async () => {
  const { db } = await import('../src/db.js');
  const pic = db.prepare("INSERT INTO task_attachments (task_id, file, mime) VALUES (?, 'shot.png', 'image/png')").run(taskId).lastInsertRowid;
  const path = join(tmp, 'attachments', String(taskId), 'shot.png');
  queue.clearQueues();
  for (const [screen, status, now] of [[IDLE, 'idle', false], [BUSY, 'busy', true]]) {
    await show(screen, status);
    await pause(2100);
    const n0 = typed().length;
    const r = await post('/api/tasks/CT-1/chat', { text: `see it ${status}`, images: [pic], ...(now ? { now: true } : {}) });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().queued, undefined, 'the words were queued, not typed');
    const t = vis(typedSince(n0));
    const at = t.indexOf(`<P>${path}</P>`);
    assert.ok(at >= 0 && at < t.indexOf(`see it ${status}`), `${now ? '«now»' : 'typed at once'}: the picture did not go first on its own: ${t}`);
  }
});
