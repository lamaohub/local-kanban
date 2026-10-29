// suites that accept, cancel and delete tasks ran that sweep against tmux's DEFAULT socket of the board,
// `local-kanban`, where the owner's live Claude sessions are. Read-only so far, but a test that ties a real
// session id (kb sends the one of the Claude running the tests) and then accepts its task would have closed
// that Claude. A board that never started Claude itself must not touch tmux at all. A stand-in tmux first on
// the PATH records every call; the last step proves it is the one the board would call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, log, db;
const SID = '12121212-3434-4565-8787-909090909090';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  log = join(tmp, 'tmux.log');
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(join(tmp, 'bin', 'tmux'), `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`);
  chmodSync(join(tmp, 'bin', 'tmux'), 0o755);
  process.env.PATH = `${join(tmp, 'bin')}:${process.env.PATH}`;
  process.env.KB_DATA_DIR = tmp;
  delete process.env.KB_TMUX_SOCKET; // the default socket — the owner's
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('iso', 'ISO', 'Iso', 4)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo', 'DEMO', 'Demo', 2)").run();
  for (const [slug, n] of [['iso', 1], ['iso', 2], ['iso', 3], ['demo', 1]]) {
    db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = ?), ?, 'T', 'todo')").run(slug, n);
  }
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const patch = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: sid ? { 'x-claude-session': sid } : {}, payload: { status } });

test('a board that never started Claude does not touch tmux when tasks are accepted, cancelled or deleted', async () => {
  // a session tied the way kb ties one — with the id of a real session, say the Claude running these tests
  await patch('ISO-1', 'prep', SID);
  await patch('ISO-1', 'review', SID);
  await patch('ISO-1', 'done');
  await patch('ISO-2', 'prep', SID);
  await patch('ISO-2', 'cancelled');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/tasks/ISO-3' })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/demo' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/ISO-1' })).json().terminal, null);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tasks/ISO-1/terminal' })).json(), { session: null });
  // the routes start the sweep without waiting for it, and starting tmux takes ~0,5 s on a busy Mac: a sleep
  // would pass by itself. The sweep the routes start is this one — run it to the end here
  const { closeFinishedTerminals } = await import('../src/phantom.js');
  assert.deepEqual(await closeFinishedTerminals(), []);
  await new Promise((r) => { setTimeout(r, 1000); });
  assert.deepEqual(calls(), [], 'the board called tmux — on the default socket, where the owner\'s Claude sessions are');
});

test('once the board has started a Claude, the sweep does look at its socket', async () => {
  // proves the stand-in above is the tmux the board calls: otherwise the test before would pass by itself
  const { markBoardSession } = await import('../src/claude-sessions.js');
  const { closeFinishedTerminals } = await import('../src/phantom.js');
  markBoardSession(SID);
  await closeFinishedTerminals();
  assert.ok(calls().some((c) => c.includes('list-panes')), `the stand-in tmux was not called: ${JSON.stringify(calls())}`);
});
