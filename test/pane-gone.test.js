import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = '6a6e0000-0000-4000-8000-000000000546';
let dir, said, phantom, live, sessions;
const answer = (what) => writeFileSync(said, what);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-pane-'));
  process.env.KB_DATA_DIR = dir;
  process.env.KB_TMUX_SOCKET = `kb-pane-test-${process.pid}`;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  said = join(dir, 'answer');
  writeFileSync(join(bin, 'tmux'), [
    '#!/bin/sh',
    `case "$(cat '${said}')" in`,
    "  gone) echo \"can't find session: =kb-x\" >&2; exit 1;;",
    '  noserver) echo "error connecting to /tmp/tmux-1/kb-x (No such file or directory)" >&2; exit 1;;',
    // a tmux that did not answer in time: the board's call to it is killed (execFile's timeout), with no word of tmux
    '  late) kill -TERM $$;;',
    '  exiting) echo "lost server" >&2; exit 1;;',
  '  empty) echo "no current target" >&2; exit 1;;',
    '  mismatch) echo "protocol version mismatch (client 8, server 7)" >&2; exit 1;;',
    // the first call finds no session, every next one is refused for good: «Continue» looks at its pane after the task's look
    `  gonethenmismatch) echo mismatch > '${said}'; echo "can't find session: =kb-x" >&2; exit 1;;`,
    `  gonetwicethenmismatch) echo gonethenmismatch > '${said}'; echo "can't find session: =kb-x" >&2; exit 1;;`,
    '  dead) echo "1|1|120|4242|4141";;',
    '  up) echo "0||120|4242|4141";;',
    `  chain) case "$*" in *list-panes*) echo "kb-${SID}|0";; *) echo "can't find pane: kb-x" >&2; exit 1;; esac;;`,
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'tmux'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  phantom = await import('../src/phantom.js');
  phantom.setLookShare(0);
  live = await import('../src/claude-live.js');
  sessions = await import('../src/claude-sessions.js');
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('the pane of a board session is gone only on tmux\'s own word — a tmux that did not answer says nothing', async () => {
  answer('gone');
  assert.equal(await phantom.phantomPane(SID), null);
  answer('noserver');
  assert.equal(await phantom.phantomPane(SID), null);
  answer('late');
  assert.deepEqual(await phantom.phantomPane(SID), { dead: false, unknown: true }, 'a tmux that did not answer reads as no pane');
  answer('exiting');
  assert.equal(await phantom.phantomPane(SID), null, 'a tmux server on its way out read as one that did not answer');
  answer('empty');
  assert.equal(await phantom.phantomPane(SID), null, 'a tmux server with no session left read as one that did not answer');
  assert.equal(await phantom.phantomView(SID), null);
  answer('dead');
  assert.equal((await phantom.phantomPane(SID)).dead, true);
  answer('up');
  assert.equal((await phantom.phantomPane(SID)).dead, false);
});

test('a fresh board start is not "session closed" while tmux does not answer — and is, once tmux says the session is not there', async () => {
  sessions.markBoardSession(SID);
  const cases = { late: false, up: false, gone: true, noserver: true, dead: true };
  for (const [what, gone] of Object.entries(cases)) {
    answer(what);
    assert.equal(await live.boardPaneGone(SID), gone, `tmux answering "${what}"`);
  }
});

// on that one look and rang again on the next. Such a look says `failed` — the watch keeps its last picture (claude-live);
// tmux's own word that there is no server is still "no terminals".
test('a look whose capture tmux failed says so, and is not read as screens with nothing on them', async () => {
  sessions.markBoardSession(SID);
  answer('chain');
  assert.equal((await phantom.boardLook()).failed, true, 'a failed capture of the screens reads as nothing on them');
  answer('late');
  assert.equal((await phantom.boardLook()).failed, true, 'a list of panes tmux did not give reads as no terminals');
  answer('noserver');
  const none = await phantom.boardLook();
  assert.deepEqual([none.failed, none.live], [undefined, []], 'no server of tmux is no terminals, not a failed look');
});

// «no terminal». Only tmux's own word closes it; a silence is `unknown`, and the pages keep what they show.
test('a terminal tmux did not answer about is not «not running», and the chat is not «not inside the board»', async () => {
  process.env.KB_CLAUDE_DIR = join(dir, 'claude'); // the chat reads no transcript and no registry of the owner's
  mkdirSync(join(dir, 'claude', 'projects'), { recursive: true });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('pg','PG','pane',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='pg'").get().id;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'At work','doing')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(id, SID);
  sessions.markBoardSession(SID);
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
  try {
    answer('late');
    assert.deepEqual(await phantom.taskTerminal(id), { session: SID, unknown: true });
    assert.deepEqual(await phantom.taskTerminal(id, { screen: true }), { session: SID, unknown: true }, 'a silence of tmux read as no terminal');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tasks/PG-1/terminal' })).json(), { session: SID, unknown: true });
    const chat = (await app.inject({ method: 'GET', url: `/api/tasks/PG-1/chat?session=${SID}` })).json();
    assert.deepEqual([chat.send, chat.state], [true, null], 'the chat of a Claude of the board read as one not inside the board');
    const said = await app.inject({ method: 'POST', url: '/api/tasks/PG-1/chat', payload: { session: SID, text: 'go on' } });
    assert.deepEqual([said.statusCode, said.json().reason], [409, 'tmux-slow'], 'words to it were refused as «only read»');
    const typed = await app.inject({ method: 'POST', url: '/api/tasks/PG-1/terminal', payload: { text: 'go on' } });
    assert.deepEqual([typed.statusCode, typed.json().reason], [409, 'tmux-slow']);
    // a comment of the card to the terminal (POST …/terminal/message) is refused alike, nothing typed
    const message = await app.inject({ method: 'POST', url: '/api/tasks/PG-1/terminal/message', payload: { text: 'go on' } });
    assert.deepEqual([message.statusCode, message.json().reason], [409, 'tmux-slow'], 'a message to a terminal tmux did not answer about was not refused as «tmux slow»');
    answer('mismatch');
    assert.deepEqual(await phantom.taskTerminal(id), { session: SID, unknown: true, broken: true });
    const look = (await app.inject({ method: 'GET', url: '/api/tasks/PG-1/terminal' })).json();
    assert.deepEqual([look.unknown, look.reason], [true, 'tmux-broken']);
    for (const [url, payload] of [['/api/tasks/PG-1/chat', { session: SID, text: 'go on' }], ['/api/tasks/PG-1/terminal', { text: 'go on' }],
      ['/api/tasks/PG-1/terminal/message', { text: 'go on' }]]) {
      const r = await app.inject({ method: 'POST', url, payload });
      assert.deepEqual([r.statusCode, r.json().reason], [409, 'tmux-broken'], `${url}: a refusal for good read as one for a few seconds`);
      assert.match(r.json().error, new RegExp(`tmux -L ${process.env.KB_TMUX_SOCKET} kill-server`), 'the refusal does not say what to do');
    }
    const { db: base } = await import('../src/db.js');
    assert.ok(base.prepare("SELECT 1 FROM app_errors WHERE message LIKE 'tmux was updated%'").get(), 'the error log does not say it');
    answer('gone');
    assert.equal(await phantom.taskTerminal(id, { screen: true }), null, 'tmux\'s word that the session is gone is no longer heard');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/tasks/PG-1/terminal' })).json(), { session: null });
    assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/PG-1/chat?session=${SID}` })).json().send, false);
  } finally { await app.close(); }
});

// the mismatch — and answered 500 with tmux's raw words, no `tmux-broken`, nothing in the error log. Said as a look says it.
test('a start inside the board that tmux refuses for good says what to do, and moves nothing', async () => {
  process.env.KB_CLAUDE_DIR = join(dir, 'claude');
  mkdirSync(join(dir, 'claude', 'projects'), { recursive: true });
  const fake = join(dir, 'bin', 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  process.env.KB_CLAUDE_BIN = fake; // never the real one
  delete process.env.KB_LAUNCH_DRYRUN;
  const folder = join(dir, 'proj');
  mkdirSync(folder, { recursive: true });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('pb','PB','start',2,?)").run(folder);
  const pid = db.prepare("SELECT id FROM projects WHERE slug='pb'").get().id;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Start me','todo')").run(pid).lastInsertRowid;
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.ready();
  try {
    answer('mismatch');
    const r = await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', text: 'Do PB-1', project: 'pb', keys: ['PB-1'] } });
    assert.deepEqual([r.statusCode, r.json().reason], [409, 'tmux-broken'], `a start tmux refused for good: ${r.body}`);
    assert.match(r.json().error, new RegExp(`tmux -L ${process.env.KB_TMUX_SOCKET} kill-server`), 'the refusal does not say what to do');
    assert.ok(!r.json().error.includes('protocol version'), 'tmux\'s raw words went to the page');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'todo', 'a start that did not happen moved the task');
    db.prepare("DELETE FROM app_errors WHERE message LIKE 'tmux was updated%'").run();
    phantom.forgetBrokenSaid();
    const again = await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', text: 'Do PB-1', project: 'pb', keys: ['PB-1'] } });
    assert.equal(again.json().reason, 'tmux-broken', again.body);
    assert.ok(db.prepare("SELECT 1 FROM app_errors WHERE message LIKE 'tmux was updated%'").get(), 'the start refused for good wrote nothing to the error log');
  } finally { await app.close(); }
});

// tmux that cannot reach its old server is refused for good with what to do, not «try again in a few seconds»
test('a start or «Continue» inside the board over a terminal tmux refuses for good says so, not «tmux was slow»', async () => {
  const SID2 = '6a6e0000-0000-4000-8000-000000000961';
  const folder = join(dir, 'folder-961');
  mkdirSync(folder);
  process.env.KB_LAUNCH_DRYRUN = '1'; // no Claude and no terminal is started: every refusal here comes before the start
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('pl','PL','launch',?,2)").run(folder).lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Tied','todo')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(id, SID2);
  sessions.markBoardSession(SID2);
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.ready();
  const launch = (payload) => app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'pl', keys: ['PL-1'], ...payload } });
  const refusedForGood = (r, what) => {
    assert.equal(r.statusCode, 409, `${what}: ${r.body}`);
    assert.equal(r.json().reason, 'tmux-broken', `${what}: a refusal for good read as one for a few seconds`);
    assert.match(r.json().error, new RegExp(`tmux -L ${process.env.KB_TMUX_SOCKET} kill-server`), `${what}: the refusal does not say what to do`);
    assert.deepEqual(r.json().keys, ['PL-1'], what);
  };
  try {
    answer('mismatch');
    refusedForGood(await launch({ text: 'go' }), 'a start');
    answer('late');
    const slow = await launch({ text: 'go' });
    assert.deepEqual([slow.statusCode, slow.json().reason], [409, 'tmux-slow'], 'a tmux slow this once read as broken for good');
    // «Continue»: the look at the task finds no terminal, the look at the session's own pane is refused for good
    answer('gonethenmismatch');
    refusedForGood(await launch({ resume: SID2 }), '«Continue»');
  } finally {
    await app.close();
    delete process.env.KB_LAUNCH_DRYRUN;
  }
});

test('«Continue» whose start tmux refuses for good says what to do, and the error log has it', async () => {
  const SID3 = '6a6e0000-0000-4000-8000-000000000976';
  const folder = join(dir, 'folder-976');
  mkdirSync(folder);
  delete process.env.KB_LAUNCH_DRYRUN;
  assert.ok(process.env.KB_CLAUDE_BIN?.startsWith(dir), 'the fake claude of the test above is not set — the real one must never start');
  const { db } = await import('../src/db.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('pr','PR','resume',?,2)").run(folder).lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Resumed','doing')").run(pid).lastInsertRowid;
  db.prepare('INSERT INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(id, SID3);
  sessions.markBoardSession(SID3);
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.ready();
  try {
    db.prepare("DELETE FROM app_errors WHERE message LIKE 'tmux was updated%'").run();
    phantom.forgetBrokenSaid();
    answer('gonetwicethenmismatch');
    const r = await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'pr', keys: ['PR-1'], resume: SID3 } });
    assert.equal(r.statusCode, 409, `«Continue» refused for good at its start: ${r.body}`);
    assert.equal(r.json().reason, 'tmux-broken', 'a start refused for good read as one for a few seconds');
    assert.match(r.json().error, new RegExp(`tmux -L ${process.env.KB_TMUX_SOCKET} kill-server`), 'the refusal does not say what to do');
    assert.ok(!r.json().error.includes('protocol version'), 'tmux\'s raw words went to the page');
    assert.deepEqual(r.json().keys, ['PR-1']);
    assert.ok(db.prepare("SELECT 1 FROM app_errors WHERE message LIKE 'tmux was updated%'").get(), 'the error log does not say it');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'doing', '«Continue» moves nothing');
  } finally { await app.close(); }
});
