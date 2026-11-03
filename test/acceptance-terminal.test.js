// for Claude that stands at its prompt, as a Claude does when it has handed in: a dry run has no terminals, so the suite
// never saw a start refused by one, nor the sweep close the Claude of the grooming.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const SOCKET = `kb-accept-t-${process.pid}`;
let app, tmp, folder, db, auto, phantom;
const CHECK = 'dddddddd-1000-4000-8000-dddddddddddd';
const inject = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:3100', ...headers } });
const add = async (slug, title, status = 'todo', labels = []) => (await inject('POST', '/api/tasks', { project: slug, title, status, labels })).json();
const move = async (key, status, sid) => { const r = await inject('PATCH', `/api/tasks/${key}`, { status }, sid ? { 'x-claude-session': sid } : {}); assert.ok(r.statusCode < 300, r.body); };
const WORDS = { title: 'Check', tasks: 'Tasks:', later: 'Later.', done: 'kb done.', report: 'Report.', run: 'Run', doTask: 'Do', back: 'Return it.' };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let n = 0;
const project = () => { n += 1; db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?, ?, ?, 1, ?)').run(`t${n}`, `T${n}X`, `P${n}`, folder); return `t${n}`; };
const alive = (sid) => { try { execFileSync(TMUX, ['-L', SOCKET, 'has-session', '-t', `=kb-${sid}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const startAt = async (slug, keys, text = 'go') => { const r = await inject('POST', '/api/launch', { mode: 'board', text, project: slug, keys }); assert.equal(r.statusCode, 200, r.body); return r.json().session; };
const until = async (f, what) => { const end = Date.now() + 8000; for (;;) { if (await f()) return; if (Date.now() > end) assert.fail(what); await sleep(50); } };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-accept-t-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-accept-tf-')));
  const claudeDir = join(tmp, 'claude');
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } }));
  mkdirSync(join(tmp, 'bin'));
  const fake = join(tmp, 'bin', 'claude');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2); const i = a.indexOf('--session-id'); const j = a.indexOf('--resume');
const sid = i >= 0 ? a[i + 1] : a[j + 1];
fs.writeFileSync(${JSON.stringify(join(claudeDir, 'sessions'))} + '/' + process.pid + '.json', JSON.stringify({ pid: process.pid, sessionId: sid, status: 'idle', statusUpdatedAt: Date.now() }));
process.stdout.write('──────────\\r\\n❯ \\r\\n──────────\\r\\n');
process.on('SIGTERM', () => process.exit(143));
process.stdin.setRawMode(true); process.stdin.resume();
`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_BIN: fake, KB_CLAUDE_DIR: claudeDir, PORT: '3100' });
  delete process.env.KB_LAUNCH_DRYRUN;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  auto = await import('../src/automations.js');
  await (await import('../src/claude-live.js')).refreshLive(undefined, async () => ({ live: [], questions: [], background: [], over: [], limited: [] }));
  phantom = await import('../src/phantom.js');
  app = Fastify();
  const { PORT } = await import('../src/config.js');
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/automations.js')).default);
  await app.ready();
  auto.setAutomationsOn(true);
});
after(async () => {
  await app?.close();
  try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_BIN', 'KB_CLAUDE_DIR', 'PORT']) delete process.env[k];
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('DEFECT CK-928: what a check returned goes back to work though the check still stands at its prompt', async () => {
  const slug = project();
  const t = await add(slug, 'work');
  const worker = await startAt(slug, [t.key]);
  await until(() => alive(worker), 'the worker did not start');
  const id = (await inject('POST', '/api/automations', { project: slug, words: WORDS, delay_min: 0, repeat: true, fix: true })).json().id;
  await move(t.key, 'doing', worker);
  const t0 = Date.now() - 60_000;
  await auto.tickAutomations(app, t0);
  await move(t.key, 'review', worker);
  await auto.tickAutomations(app, t0 + 1000);
  await auto.tickAutomations(app, t0 + 2000);
  const rule = () => db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
  const check = db.prepare('SELECT * FROM tasks WHERE id = ?').get(rule().task_id);
  assert.ok(check, 'the check was not made');
  const session = db.prepare('SELECT session_id FROM task_sessions WHERE task_id = ?').get(check.id).session_id;
  await until(() => alive(session), 'the check did not start');
  await move(t.key, 'todo', session);
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(check.id);
  await sleep(600); // the registry of the stand-ins
  await auto.tickAutomations(app, Date.now());
  assert.equal(rule().error, null, `the fix was refused: ${rule().error}`);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.id).status, 'prep', 'the task did not go back to work');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-928: only the fix of an automation closes a Claude at its prompt, and never one being looked at', async () => {
  const { ADOPT_TOKEN } = await import('../src/claude-sessions.js');
  const slug = project();
  const t = await add(slug, 'work');
  const worker = await startAt(slug, [t.key]);
  await until(() => alive(worker), 'the worker did not start');
  await move(t.key, 'todo', worker);
  await sleep(600); // the registry of the stand-ins
  const start = (extra) => inject('POST', '/api/launch', { mode: 'board', text: 'go', project: slug, keys: [t.key], ...extra });
  phantom.setLookHold(0);
  assert.equal((await start({ adopt: ADOPT_TOKEN })).statusCode, 409, 'a start with no word about room went over a live Claude');
  assert.ok(alive(worker), 'a resume sends `adopt` with the keys of its task too: it closed a live terminal');
  assert.equal((await start({ makeRoom: 'guess' })).statusCode, 409, 'the word of a stranger makes room');
  assert.ok(alive(worker));
  phantom.setLookHold(60_000);
  phantom.noteLook(worker);
  assert.equal((await start({ makeRoom: ADOPT_TOKEN })).statusCode, 409, 'the terminal someone is looking at is taken from under them');
  assert.ok(alive(worker), 'the terminal someone is looking at was closed');
  phantom.setLookHold(0);
  assert.equal((await start({ makeRoom: ADOPT_TOKEN })).statusCode, 200, 'the fix waits for a Claude that does nothing');
  assert.equal(alive(worker), false);
});

test('DEFECT CK-929: the sweep leaves the Claude of the grooming at its prompt', async () => {
  const slug = project();
  await add(slug, 'an idea', 'backlog');
  const d = new Date();
  const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const id = (await inject('POST', '/api/automations', { project: slug, kind: 'schedule-groom', plan: { at, day: null }, words: { run: 'Run', groom: 'Groom (grooming mode):' } })).json().id;
  const before = new Set(db.prepare('SELECT session_id FROM board_sessions').all().map((r) => r.session_id));
  await auto.tickAutomations(app, Date.now());
  const sid = db.prepare('SELECT session_id FROM board_sessions').all().map((r) => r.session_id).find((s) => !before.has(s));
  assert.ok(sid, 'the grooming did not start');
  await until(() => alive(sid), 'the Claude of the grooming did not start');
  await sleep(600);
  await phantom.closeFinishedTerminals();
  assert.equal(alive(sid), true, 'the sweep closed a Claude that stands at its prompt, its questions to the person with it');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-929: the mark of a Claude with no task outlives a restart of the board', () => {
  phantom.markTaskless('s-groom');
  assert.ok(JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'phantom.taskless'").get().value).includes('s-groom'), 'a restart closes the grooming with its question');
});

test('DEFECT CK-929: a task a live Claude holds does not hold the free tasks of the queue', async () => {
  const slug = project();
  const held = await add(slug, 'returned');
  const s = await startAt(slug, [held.key]);
  await until(() => alive(s), 'it did not start');
  await move(held.key, 'doing', s); await move(held.key, 'review', s); await move(held.key, 'todo', s);
  const free = await add(slug, 'free');
  await inject('POST', '/api/automations', { project: slug, kind: 'todo-queue', delay_min: 0, words: { run: 'Run', doTask: 'Do' } });
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await auto.tickAutomations(app, t0 + 1000);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(free.id).status, 'prep', 'the free task stays in To do for as long as the other Claude rests');
});
