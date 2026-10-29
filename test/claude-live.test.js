// The state comes from Claude Code's own registry of live sessions (<claude dir>/sessions/<pid>.json),
// checked against whether the process is still there. "Working" and "waiting" are shown only on the
// task the session is on right now — a batch is moved to prep together, and without that rule every
// card of it would say "working". A task in work whose last session is gone says "session closed".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import vm from 'node:vm';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
let app, tmp, claude, db, live;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  live = await import('../src/claude-live.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','LV','Demo board',6)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, archived) VALUES ('old','OL','Old board',2,1)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const old = db.prepare("SELECT id FROM projects WHERE slug='old'").get().id;
  for (const no of [1, 2, 3, 4]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Archived task','todo')").run(old);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.ready();
  const move = (url, status, sid) => app.inject({ method: 'PATCH', url, headers: { 'x-claude-session': sid }, payload: { status } });
  // S1 takes a batch: LV-1 and LV-2 to prep, then works on LV-1
  await move('/api/tasks/LV-1', 'prep', S1);
  await move('/api/tasks/LV-2', 'prep', S1);
  await move('/api/tasks/LV-1', 'doing', S1);
  // S2 works on LV-3; LV-4 stays in To do; a task in work on an archived board has its own session
  await move('/api/tasks/LV-3', 'doing', S2);
  await move('/api/tasks/OL-1', 'doing', S3);
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const reg = (file, data) => writeFileSync(join(claude, 'sessions', file), typeof data === 'string' ? data : JSON.stringify(data));
const aliveOnly = (...pids) => (pid) => pids.includes(pid);
const states = async (isAlive) => Object.fromEntries((await live.liveTasks(isAlive)).map((x) => [x.key, x.claude]));

test('working is shown only on the task the session is on, not on the rest of its batch', async () => {
  reg('101.json', { pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  reg('202.json', { pid: 202, sessionId: S2, status: 'busy', statusUpdatedAt: 2000 });
  assert.deepEqual(await states(aliveOnly(101, 202)), { 'LV-1': 'busy', 'LV-3': 'busy' },
    'LV-2 waits its turn in the batch; LV-4 is not in work; the archived board is not shown');
});

test('waiting and idle mean the session waits for the person; an unknown status still means alive', async () => {
  reg('101.json', { pid: 101, sessionId: S1, status: 'waiting', statusUpdatedAt: 1500 });
  reg('202.json', { pid: 202, sessionId: S2, status: 'idle', statusUpdatedAt: 2500 });
  assert.deepEqual(await states(aliveOnly(101, 202)), { 'LV-1': 'waiting', 'LV-3': 'idle' });
  reg('202.json', { pid: 202, sessionId: S2, status: 'compacting', statusUpdatedAt: 2600 });
  assert.equal((await states(aliveOnly(101, 202)))['LV-3'], 'busy');
  const since = (await live.liveTasks(aliveOnly(101, 202))).find((x) => x.key === 'LV-1').since;
  assert.equal(since, 1500, 'the card cannot say for how long it has been waiting');
});

test('a dead process is a closed session, for every task in work that it led', async () => {
  reg('101.json', { pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  assert.deepEqual(await states(aliveOnly(202)), { 'LV-1': 'gone', 'LV-2': 'gone', 'LV-3': 'busy' },
    'a registry file outlives a crashed process; a task its dead session left in work is stuck');
});

test('the registry is read tolerantly: broken files are skipped, the live copy of a session wins', async () => {
  reg('broken.json', '{"pid": 7, "sessio');
  reg('nosid.json', { pid: 8, status: 'busy' });
  reg('notuuid.json', { pid: 9, sessionId: '../../x', status: 'busy' });
  // the same session, resumed under a new pid; its dead older file (101.json) is still there. The live copy
  // is put once before and once after the dead one, so the rule holds whatever order the folder is read in.
  for (const file of ['050.json', '999.json']) {
    reg(file, { pid: 303, sessionId: S1, status: 'idle', statusUpdatedAt: 900 });
    const r = await live.readRegistry(aliveOnly(202, 303));
    assert.deepEqual([...r.keys()].sort(), [S1, S2]);
    assert.equal(r.get(S1).pid, 303, `the dead older copy of the session shadowed the live one (${file})`);
    assert.equal((await states(aliveOnly(202, 303)))['LV-1'], 'idle');
    rmSync(join(claude, 'sessions', file));
  }
  for (const f of ['broken.json', 'nosid.json', 'notuuid.json']) rmSync(join(claude, 'sessions', f));
});

test('the board hears task.live only when a state changed', async () => {
  const { bus } = await import('../src/bus.js');
  const heard = [];
  const on = (e) => { if (e.type === 'task.live') heard.push(e.data); };
  bus.on('event', on);
  reg('101.json', { pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  reg('202.json', { pid: 202, sessionId: S2, status: 'busy', statusUpdatedAt: 2000 });
  assert.equal(await live.refreshLive(aliveOnly(101, 202)), true);
  assert.equal(await live.refreshLive(aliveOnly(101, 202)), false, 'the same states rang again');
  reg('101.json', { pid: 101, sessionId: S1, status: 'waiting', statusUpdatedAt: 3000 });
  assert.equal(await live.refreshLive(aliveOnly(101, 202)), true);
  bus.off('event', on);
  assert.equal(heard.length, 2);
  assert.deepEqual(heard[1].tasks.map((x) => [x.key, x.claude]), [['LV-1', 'waiting'], ['LV-3', 'busy']]);
});

test('the dashboard lists what waits for the person, under its project name; working sessions are not listed', async () => {
  const d = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json();
  assert.deepEqual(d.waiting.claude.map((x) => [x.key, x.claude, x.project, x.status]), [['LV-1', 'waiting', 'Demo board', 'doing']]);
  assert.equal(d.waiting.claude[0].since, 3000);
});

test('the dashboard answer from its cache still says who waits right now', async () => {
  await app.inject({ method: 'GET', url: '/api/dashboard' }); // the cache holds an answer
  reg('101.json', { pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 5000 });
  assert.equal(await live.refreshLive(aliveOnly(101, 202)), true);
  const d = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json();
  assert.deepEqual(d.waiting.claude, [], 'the answer from the cache still says Claude waits on LV-1, while it works');
});

test('GET /api/live gives the starting picture, checked against processes that really run', async () => {
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  reg('202.json', { pid: 2 ** 31 - 2, sessionId: S2, status: 'busy', statusUpdatedAt: 2000 }); // no such process
  const r = (await app.inject({ method: 'GET', url: '/api/live' })).json();
  assert.deepEqual(r.tasks.map((x) => [x.key, x.claude]), [['LV-1', 'busy'], ['LV-3', 'gone']]);
});

test('a registry file whose pid now belongs to another process is a closed session', async () => {
  // answers "alive", and the card said "working" about a stranger. Claude Code itself checks procStart, the
  // start of the process the way `ps -o lstart=` prints it in the C locale and UTC; so does the board now
  const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000, procStart: 'Thu Jan  1 00:00:00 1970' });
  rmSync(join(claude, 'sessions', '202.json'), { force: true });
  assert.equal((await live.readRegistry()).get(S1).alive, false, 'a running process of another start is taken for the Claude of the file');
  assert.equal((await live.liveTasks()).find((x) => x.key === 'LV-1')?.claude, 'gone');
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000, procStart: start });
  assert.equal((await live.readRegistry()).get(S1).alive, true, 'the very process of the file is taken for another one');
  // ps that does not run, or says nothing of the pid (BusyBox has no lstart), leaves the word to kill(pid, 0) —
  // as Claude Code itself does; every Claude would read as gone otherwise
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000, procStart: 'Fri Jan  2 00:00:00 1970' });
  assert.equal((await live.readRegistry(undefined, async () => null)).get(S1).alive, true);
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000, procStart: 'Sat Jan  3 00:00:00 1970' });
  assert.equal((await live.readRegistry(undefined, async () => new Map())).get(S1).alive, true, 'a pid ps said nothing of reads as another process');
  // a file without procStart (an older Claude Code) is judged by kill(pid, 0) alone
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  assert.equal((await live.readRegistry()).get(S1).alive, true);
  rmSync(join(claude, 'sessions', '101.json'), { force: true });
});

test('a session whose kb sent no session id gets its badge from the unsigned moves of its tasks', async () => {
  // the session had no focus, and the card in work showed no badge while the terminal worked on it
  const S4 = '44444444-4444-4444-8444-444444444444';
  const { tieLaunched, markBoardSession } = await import('../src/claude-sessions.js');
  const id = db.prepare("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix = 'LV' AND t.task_no = 4").get().id;
  tieLaunched(id, S4);
  markBoardSession(S4);
  db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-1 minute') WHERE session_id = ?").run(S4);
  await app.inject({ method: 'PATCH', url: '/api/tasks/LV-4', payload: { status: 'doing' } }); // no session header
  reg('404.json', { pid: 404, sessionId: S4, status: 'busy', statusUpdatedAt: 4000 });
  assert.equal((await states(aliveOnly(404)))['LV-4'], 'busy', 'the task the board\'s Claude works on has no badge');
});

test('the card applies task.live to its badges and the board is not re-read for it', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /if \(ev\.type === 'task\.live'\) \{[^\n]*applyLive\(ev\.data\?\.tasks\)[^\n]*return; \}/,
    'task.live would fall into the queue and refresh the whole board');
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  assert.match(board, /const b = l && WORKING\.has\(t\.status\) && LIVE_BADGE\[/,
    'a badge would show on cards that are not in work');
});

test('a question on the screen of the board\'s terminal goes out with task.live, for a task in review too', async () => {
  // said idle, the task was in Review, where a card has no badge, and the board rang nothing
  const { bus } = await import('../src/bus.js');
  await app.inject({ method: 'PATCH', url: '/api/tasks/LV-3', headers: { 'x-claude-session': S2 }, payload: { status: 'review' } });
  const none = async () => ({ questions: [], background: [] });
  await live.refreshLive(aliveOnly(), none);
  const heard = [];
  const on = (e) => { if (e.type === 'task.live') heard.push(e.data); };
  bus.on('event', on);
  const asking = async () => ({ questions: [S2, '99999999-9999-4999-8999-999999999999'], background: [] }); // the second session has no task here
  assert.equal(await live.refreshLive(aliveOnly(), asking), true, 'an open question did not reach the page');
  assert.equal(await live.refreshLive(aliveOnly(), asking), false, 'the same question rang again');
  assert.equal(await live.refreshLive(aliveOnly(), none), true, 'an answered question stayed on the page');
  bus.off('event', on);
  assert.deepEqual(heard.map((d) => d.questions), [[{ id: heard[0].questions[0]?.id, key: 'LV-3', project: 'demo', title: 'Task 3' }], []]);
  assert.deepEqual(await live.terminalQuestions(async () => []), []);
  const r = (await app.inject({ method: 'GET', url: '/api/live' })).json();
  assert.deepEqual(r.questions, [], 'a board that started no terminal of its own looked into tmux');
});

test('the page rings for a new question of a terminal, and not for one open before it loaded', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /maybeQuestionAlert\(applyTerminalQuestions\(ev\.data\?\.questions\), maybeWaitingAlert\(applyLive\(ev\.data\?\.tasks\)\)\)/,
    'task.live does not ring for a question on a terminal');
  assert.match(sse, /const asking = fresh\.filter\(\(q\) => !rang\.has\(q\.id\)\);/, 'one task rings twice — for waiting and for its question');
});

test('a question the page first hears of from a refresh rings; only the first picture stays silent', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  // from a declaration to the end of the function that follows it
  const cut = (from, fn) => {
    const a = sse.indexOf(from); const f = sse.indexOf(fn, a);
    assert.ok(a >= 0 && f >= 0, `${from} … ${fn} is gone from sse.js`);
    return sse.slice(a, sse.indexOf('\n}\n', f) + 2);
  };
  const code = `${cut('let terminalAsking', 'function maybeQuestionAlert(')}\n${cut('let liveLoaded', 'async function loadLive(')}`;
  let answer = { tasks: [], questions: [] };
  const rang = [];
  const box = {
    api: async () => answer, applyLive: () => [], maybeWaitingAlert: () => new Set(),
    playReviewSound: () => rang.push('sound'), getSetting: () => false, markNowEntry() {}, repaintReview() {}, state: {},
    setTerminalQuestions() {},
  };
  vm.createContext(box);
  vm.runInContext(`${code}\nthis.loadLive = loadLive;`, box);
  answer = { tasks: [], questions: [{ id: 1, key: 'LV-1' }] };
  await box.loadLive();
  assert.equal(rang.length, 0, 'a question open before the page loaded rang');
  answer = { tasks: [], questions: [{ id: 1, key: 'LV-1' }, { id: 2, key: 'LV-2' }] };
  await box.loadLive();
  assert.equal(rang.length, 1, 'a new question heard of from a refresh did not ring');
  await box.loadLive();
  assert.equal(rang.length, 1, 'the same question rang again');
});

test('a picture asked for before a newer task.live is not applied over it', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const cut = (from, fn) => { const a = sse.indexOf(from); const f = sse.indexOf(fn, a); return sse.slice(a, sse.indexOf('\n}\n', f) + 2); };
  let release;
  const rang = [];
  const applied = [];
  const box = {
    api: () => new Promise((r) => { release = r; }), applyLive: (t) => { applied.push(t); return []; }, maybeWaitingAlert: () => new Set(),
    playReviewSound: () => rang.push('sound'), getSetting: () => false, markNowEntry() {}, repaintReview() {}, state: {},
    setTerminalQuestions() {},
  };
  vm.createContext(box);
  vm.runInContext(`${cut('let terminalAsking', 'function maybeQuestionAlert(')}\n${cut('let liveLoaded', 'async function loadLive(')}
this.loadLive = loadLive; this.event = () => { liveEvents++; };`, box);
  const first = box.loadLive(); release({ tasks: [], questions: [] }); await first;
  const late = box.loadLive();
  box.event(); // the question closed meanwhile, and the page heard it
  release({ tasks: ['old'], questions: [{ id: 9, key: 'LV-9' }] });
  await late;
  assert.deepEqual(applied, [[]], 'an answer older than the events was applied');
  assert.equal(rang.length, 0, 'a question already closed rang from an old answer');
});
