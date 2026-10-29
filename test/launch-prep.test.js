// inside the board, in the Terminal, in the Claude app — and the server moves the ones still in Backlog or To do to
// prep right then, before that Claude has read a word; they used to wait in To do until it came up and said
// `kb mv <key> prep` (9–24 s on the owner's machine). The Claude that was started must still hold them: the skill
// is that session's where the board names the session (inside the board, the Terminal: `claude --session-id`). The
// Claude app names its own session: its move is nobody's until the first session takes the task, which signs it.
// the prompt in, the person sends it; Claude moves its tasks itself (the moves "nobody's yet" are of older starts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { boardOnly, effortOf, startEffort, checksOnly, launchPick } from '../public/js/launch-rules.js';

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';
const OTHER = 'b2b2b2b2-0000-4000-8000-000000000002';
const THIRD = 'c3c3c3c3-0000-4000-8000-000000000003';
const OLDER = 'd4d4d4d4-0000-4000-8000-000000000004';
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the Claude app is opened by `open` on a Mac that has it; elsewhere ▶ never starts it this way
const APP_HERE = process.platform === 'darwin' && ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')].some((p) => existsSync(p));
let app, tmp, folder, claudeDir, bin, db, sessions, tasks, live, now, feed, bus;

let savedHome;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  // empty one here, so the commands name the `claude` of the test's PATH, as they do on a machine where it is on PATH
  savedHome = process.env.HOME; process.env.HOME = join(tmp, 'home');
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-folder-')));
  claudeDir = join(tmp, 'claude');
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_CLAUDE_DIR: claudeDir, KB_LAUNCH_DRYRUN: '1' });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  sessions = await import('../src/claude-sessions.js');
  tasks = await import('../src/routes/tasks.js');
  live = await import('../src/claude-live.js');
  now = await import('../src/claude-now.js');
  feed = await import('../src/work-feed.js');
  ({ bus } = await import('../src/bus.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('site','ST','Site',1,?)").run(folder);
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('gone','GN','Gone',1,'/nowhere/at/all')").run();
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register(tasks.default);
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

const numbers = new Map();
/** New tasks in the given statuses, straight in the database: [key, …]. */
function addTasks(statuses, project = 'site') {
  const p = db.prepare('SELECT id, prefix FROM projects WHERE slug = ?').get(project);
  return statuses.map((status) => {
    const no = (numbers.get(project) || 0) + 1;
    numbers.set(project, no);
    db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,?)').run(p.id, no, `Task ${no}`, status);
    return `${p.prefix}-${no}`;
  });
}
const rowsOf = (keys) => keys.map((k) => tasks.resolveTask(k));
const statusOf = (key) => tasks.resolveTask(key).status;
const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload: { status }, headers: sid ? { 'x-claude-session': sid } : {} });
const post = (body) => app.inject({ method: 'POST', url: '/api/launch', payload: body });
/** The task's moves into prep: who made each and whether ▶ made it. */
const prepMoves = (key) => db.prepare(`SELECT e.session_id, l.via FROM task_events e LEFT JOIN task_launches l ON l.event_id = e.id
  WHERE e.task_id = ? AND e.status = 'prep' ORDER BY e.id`).all(tasks.resolveTask(key).id).map((r) => ({ ...r }));
const reg = (pid, sessionId, status) => writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, status, statusUpdatedAt: Date.now() }));
const unreg = (pid) => rmSync(join(claudeDir, 'sessions', `${pid}.json`), { force: true });
const aliveOnly = (...pids) => (pid) => pids.includes(pid);
/** The next task.live that `test` accepts — or a failure after 5 s. */
function heard(test) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off('event', on); reject(new Error('no task.live came')); }, 5000);
    function on(e) { if (e.type === 'task.live' && test(e.data)) { clearTimeout(timer); bus.off('event', on); resolve(e.data); } }
    bus.on('event', on);
  });
}
const badges = async (keys, isAlive = () => false) => Object.fromEntries((await live.liveTasks(isAlive)).filter((x) => keys.includes(x.key)).map((x) => [x.key, x.claude]));

test('▶ moves its tasks from Backlog and To do to Preparation at once, as the session the board started; that session holds them', async () => {
  const [a, b, c, d] = addTasks(['todo', 'backlog', 'doing', 'review']);
  assert.deepEqual(tasks.moveLaunched(rowsOf([a, b, c, d]), SID, 'board'), [a, b]);
  assert.deepEqual([a, b, c, d].map(statusOf), ['prep', 'prep', 'doing', 'review'], 'a task already in work or in Review was moved by a start');
  for (const k of [a, b]) assert.deepEqual(prepMoves(k), [{ session_id: SID, via: 'board' }], `${k}: the move is not the started session's, or not marked as ▶'s`);
  assert.deepEqual(prepMoves(c), []);
  // the Claude that was started takes them, as the skill has it do first thing; another session and a person are refused
  for (const k of [a, b]) {
    assert.equal((await move(k, 'prep', SID)).statusCode, 200, `${k}: the Claude the board started was refused its own task`);
    assert.equal((await move(k, 'prep', OTHER)).statusCode, 409, `${k}: another session took a task the started Claude holds`);
    // its kb may send no session id (an older kb first on its PATH): confirming its own task goes, and claims nothing
    assert.equal((await move(k, 'prep')).statusCode, 200, `${k}: the Claude ▶ started was refused its own task for want of a session id`);
  }
  assert.deepEqual(prepMoves(a), [{ session_id: SID, via: 'board' }], 'taking the task wrote a second move into prep');
  const card = (await app.inject({ method: 'GET', url: `/api/tasks/${a}` })).json();
  assert.deepEqual(card.sessions.map((s) => s.session_id), [SID]);
  assert.deepEqual(card.events.map((e) => e.status), ['prep'], 'the history of the card does not show the move');
});

test('▶ in the Claude app: the move is nobody\'s until the first session takes the task — that one holds it, the next is refused', async () => {
  const [a, b] = addTasks(['todo', 'todo']);
  assert.deepEqual(tasks.moveLaunched(rowsOf([a, b]), null, 'desktop'), [a, b]);
  assert.deepEqual(prepMoves(a), [{ session_id: null, via: 'desktop' }]);
  // the Claude the app started, whose kb sends no session id, confirms its task — and holds nothing by it
  assert.equal((await move(a, 'prep')).statusCode, 200, 'the Claude ▶ started was refused its own task for want of a session id');
  assert.deepEqual(prepMoves(a), [{ session_id: null, via: 'desktop' }], 'a request without a session signed the move');
  assert.equal((await move(a, 'prep', SID)).statusCode, 200, 'the session of the Claude app was refused the task it was started on');
  assert.deepEqual(prepMoves(a), [{ session_id: SID, via: 'desktop' }], 'the session that took the task did not sign the move');
  assert.equal((await move(a, 'prep', OTHER)).statusCode, 409, 'a second session took the task the first one holds');
  assert.equal((await move(a, 'prep', SID)).statusCode, 200, 'the session that took the task was refused its own repeat');
  // b is still nobody's: whoever asks first takes it
  assert.equal((await move(b, 'prep', OTHER)).statusCode, 200);
  assert.equal((await move(b, 'prep', SID)).statusCode, 409);
  assert.deepEqual(prepMoves(b), [{ session_id: OTHER, via: 'desktop' }]);
});

test('a move into prep that ▶ did not make stays nobody\'s: no session may claim it', async () => {
  // the person (a manual task), or a kb that sends no session: such a move was never ▶'s
  const [a] = addTasks(['todo']);
  assert.equal((await move(a, 'prep')).statusCode, 200);
  assert.equal((await move(a, 'prep', SID)).statusCode, 409, 'a session claimed a task in prep that nobody started it on');
  assert.deepEqual(prepMoves(a), [{ session_id: null, via: null }]);
  // and a request without a session is let through only on a task ▶ moved — never on one a session moved itself
  const [c] = addTasks(['todo']);
  assert.equal((await move(c, 'prep', OTHER)).statusCode, 200);
  assert.equal((await move(c, 'prep')).statusCode, 409, 'a request without a session was let onto a task a session holds');
  // and a session's own move into prep, made by kb, is no launch either
  const [b] = addTasks(['todo']);
  assert.equal((await move(b, 'prep', SID)).statusCode, 200);
  assert.deepEqual(prepMoves(b), [{ session_id: SID, via: null }]);
});

test('a start that is refused or only pretends (KB_LAUNCH_DRYRUN) moves nothing', async () => {
  const [a, b] = addTasks(['todo', 'backlog']);
  const [g] = addTasks(['todo'], 'gone');
  // a dry run starts no Claude: a task in prep without one would sit in a column only Claude moves
  for (const mode of ['board', 'terminal', 'desktop']) {
    const r = await post({ mode, text: `Do ${a} ${b}`, project: 'site', keys: [a, b] });
    assert.ok([200, 501].includes(r.statusCode), `${mode}: ${r.body}`); // the app is not opened this way off a Mac
    assert.equal(r.json().prep, undefined, `${mode}: a dry run says it moved something`);
  }
  const dry = (await post({ mode: 'terminal', text: 'x', project: 'site', keys: [a] })).json();
  assert.match(dry.session, SESSION_RE, 'a dry run does not say which session the Terminal would start');
  assert.ok(dry.args.join(' ').includes(`claude --session-id '${dry.session}' 'x'`), dry.args.join(' '));
  for (const [body, code] of [
    [{ mode: 'terminal', text: 'x', project: 'gone', keys: [g] }, 409], // the project has no folder here
    [{ mode: 'desktop', text: 'x', project: 'gone', keys: [g] }, 409],
    [{ mode: 'board', text: 'x', project: 'gone', keys: [g] }, 409],
    [{ mode: 'terminal', text: 'x', project: 'site', keys: [a, 'ST-999'] }, 404],
    [{ mode: 'terminal', text: 'x', project: 'site', keys: [a, g] }, 400], // a task of another project
    [{ mode: 'terminal', text: 'x', project: 'site', keys: ['ST-1; rm -rf /'] }, 400],
    [{ mode: 'terminal', text: 'x', project: 'site', keys: [] }, 400],
    [{ mode: 'terminal', resume: SID, project: 'site', keys: [a] }, 400], // opening a session is not a start
  ]) {
    const r = await post(body);
    assert.equal(r.statusCode, code, `${JSON.stringify(body)}: ${r.body}`);
  }
  assert.deepEqual([a, b, g].map(statusOf), ['todo', 'backlog', 'todo']);
});

test('▶ in the Terminal starts Claude under a session id the board picks, and the tasks move as that session', async () => {
  const [a, b] = addTasks(['todo', 'todo']);
  // the terminal that would open: a stand-in first on the PATH writes down what it was asked to run
  const term = process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator';
  const said = join(tmp, 'terminal.log');
  writeFileSync(join(bin, term), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${said}'\n`);
  chmodSync(join(bin, term), 0o755);
  const { onPath } = await import('../src/launch.js');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  delete process.env.KB_LAUNCH_DRYRUN;
  try {
    assert.equal(onPath(term), join(bin, term), 'the real terminal would open');
    // the cards say "starting" at once: ▶ has the states computed then, not at the watch's next look in up to 3 s
    // (no watch runs in this file — without that ask the event never comes)
    const starting = heard((d) => d.tasks.some((x) => x.key === a && x.claude === 'starting'));
    const r = await post({ mode: 'terminal', text: `Run the kanban skill\nDo ${a} ${b}`, project: 'site', keys: [a, b] });
    assert.equal(r.statusCode, 200, r.body);
    await starting;
    const { session, prep } = r.json();
    assert.match(session, SESSION_RE);
    assert.deepEqual(prep, [a, b]);
    assert.ok(readFileSync(said, 'utf8').includes(`claude --session-id '${session}' 'Run the kanban skill`), 'Claude started in the Terminal under another session id than the board moved the tasks as');
    for (const k of [a, b]) {
      assert.deepEqual(prepMoves(k), [{ session_id: session, via: 'terminal' }], k);
      assert.equal((await move(k, 'prep', session)).statusCode, 200, `${k}: the Claude in the Terminal was refused its own task`);
      assert.equal((await move(k, 'prep', OTHER)).statusCode, 409, `${k}: another session took it`);
    }
    // the card knows its Claude at once, as with a start inside the board
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/tasks/${a}` })).json().sessions.map((s) => s.session_id), [session]);
    // a card left in prep by a session that is gone: ▶ (a tab that still shows it in To do) does not move it again,
    const [p] = addTasks(['todo']);
    assert.equal((await move(p, 'prep', OTHER)).statusCode, 200);
    db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-1 minute') WHERE session_id = ?").run(OTHER);
    db.prepare("UPDATE task_events SET created_at = datetime('now', '-1 minute') WHERE session_id = ?").run(OTHER);
    const again = await post({ mode: 'terminal', text: `Do ${p}`, project: 'site', keys: [p] });
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(again.json().prep, []);
    assert.deepEqual(prepMoves(p), [{ session_id: OTHER, via: null }], 'a task already in prep got a second move into it');
    assert.equal((await move(p, 'prep', again.json().session)).statusCode, 200, 'the Claude started on a card left in prep was refused it');
    // the terminal fails to open: nothing moves
    const [c] = addTasks(['todo']);
    writeFileSync(join(bin, term), '#!/bin/sh\necho "no terminal today" >&2\nexit 1\n');
    const no = await post({ mode: 'terminal', text: `Do ${c}`, project: 'site', keys: [c] });
    assert.equal(no.statusCode, 500, no.body);
    assert.equal(statusOf(c), 'todo', 'a start that failed moved its task');
  } finally {
    process.env.PATH = path;
    process.env.KB_LAUNCH_DRYRUN = '1';
  }
});

test('CK-588: ▶ in the Claude app moves nothing — the person sends the prompt there, then Claude moves its tasks', { skip: !APP_HERE && 'the Claude app is not on this computer' }, async () => {
  const [a] = addTasks(['todo']);
  const said = join(tmp, 'open.log');
  writeFileSync(join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${said}'\n`);
  chmodSync(join(bin, 'open'), 0o755);
  const { onPath } = await import('../src/launch.js');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  delete process.env.KB_LAUNCH_DRYRUN;
  try {
    assert.equal(onPath('open'), join(bin, 'open'), 'the real Claude app would open');
    const r = await post({ mode: 'desktop', text: `Run the kanban skill\nDo the task ${a}`, project: 'site', keys: [a] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().prep, r.json().session], [[], undefined]);
    assert.match(readFileSync(said, 'utf8'), /^claude:\/\/code\/new\?/);
    assert.equal(statusOf(a), 'todo', 'the prompt only lies in the app, unsent — and the task was in Preparation already');
    assert.deepEqual(prepMoves(a), []);
  } finally {
    process.env.PATH = path;
    process.env.KB_LAUNCH_DRYRUN = '1';
  }
});

test('the work feed of a session ▶ started begins with the task it was started on, from its first line', async () => {
  const [a, b] = addTasks(['todo', 'todo']);
  for (const t of rowsOf([a, b])) sessions.tieLaunched(t.id, THIRD);
  sessions.markBoardSession(THIRD);
  tasks.moveLaunched(rowsOf([a, b]), THIRD, 'board');
  const [ia, ib] = rowsOf([a, b]).map((t) => t.id);
  assert.deepEqual(feed.sessionEvents(THIRD).map((e) => [e.task_id, e.status]), [[ia, 'prep'], [ib, 'prep']]);
  const w = feed.sessionWindows(feed.sessionEvents(THIRD));
  assert.deepEqual(w.map((x) => [x.task_id, x.from, x.to]), [[ia, -Infinity, null]], 'the batch took the focus off the first task, or the start of the transcript belongs to no task');
  // the Claude app's session: nothing of the task is its own until it takes it, then the move of ▶ is
  const [c] = addTasks(['todo']);
  tasks.moveLaunched(rowsOf([c]), null, 'desktop');
  const app1 = 'a8a8a8a8-0000-4000-8000-000000000008';
  assert.deepEqual(feed.sessionEvents(app1), []);
  assert.equal((await move(c, 'prep', app1)).statusCode, 200);
  assert.deepEqual(feed.sessionEvents(app1).map((e) => [e.task_id, e.status]), [[tasks.resolveTask(c).id, 'prep']],
    'the session that took the task has no move of its own: no feed and no badge until it moves the task on');
});

test('the card says "starting" while the Claude ▶ started is not up yet — on every task of the start — and "session closed" once the start is old', async () => {
  const [a, b] = addTasks(['todo', 'todo']);
  const S = 'e5e5e5e5-0000-4000-8000-000000000005';
  for (const t of rowsOf([a, b])) sessions.tieLaunched(t.id, S);
  tasks.moveLaunched(rowsOf([a, b]), S, 'board');
  assert.deepEqual(await badges([a, b]), { [a]: 'starting', [b]: 'starting' }, 'a Claude started a moment ago reads as a closed session');
  // up: the registry has it — "working" goes on the task it is on, as for any batch
  reg(5501, S, 'busy');
  assert.deepEqual(await badges([a, b], aliveOnly(5501)), { [a]: 'busy' });
  // it is gone, and its start is older than the grace: it is a closed session, not one that is starting
  unreg(5501);
  db.prepare("UPDATE task_events SET created_at = datetime('now', ?) WHERE session_id = ?").run(`-${sessions.LAUNCH_GRACE_S + 5} seconds`, S);
  assert.deepEqual(await badges([a, b]), { [a]: 'gone', [b]: 'gone' });
});

test('a task started anew in the Claude app waits to start there until a session takes it — not the closed session that had it before', async () => {
  const [a, r] = addTasks(['todo', 'todo']);
  // an older session studied it and handed it back to To do; another of its tasks is in Review
  for (const st of ['prep', 'todo']) await move(a, st, OLDER);
  for (const st of ['prep', 'review']) await move(r, st, OLDER);
  db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-1 hour'), last_seen = datetime('now', '-1 hour') WHERE session_id = ?").run(OLDER);
  tasks.moveLaunched(rowsOf([a]), null, 'desktop');
  assert.deepEqual(await badges([a]), { [a]: 'unsent' }, 'the card says the older session is closed, "starting", or nothing at all');
  let d = await now.nowRuns(() => false);
  const run = d.runs.find((x) => x.tasks.some((t) => t.key === a));
  assert.deepEqual([run.session, run.claude, run.stale], [null, 'unsent', false], 'Claude now puts the start among the runs nobody leads');
  assert.ok(!d.runs.some((x) => x.session === OLDER), 'the older session shows up as a run with nothing of it in work');
  // the dashboard's "waiting for you" lists nothing for it: Claude is not waiting for the person, it has not started
  await live.refreshLive(() => false);
  const dash = (await app.inject({ method: 'GET', url: '/api/dashboard' })).json();
  assert.ok(!dash.waiting.claude.some((x) => x.key === a), 'a task that is starting is listed as waiting for the person');
  // the Claude of the app takes it: from then on it is that session's
  const S = 'f6f6f6f6-0000-4000-8000-000000000006';
  assert.equal((await move(a, 'prep', S)).statusCode, 200);
  reg(6601, S, 'busy');
  assert.deepEqual(await badges([a], aliveOnly(6601)), { [a]: 'busy' });
  d = await now.nowRuns(aliveOnly(6601));
  assert.deepEqual(d.runs.filter((x) => x.tasks.some((t) => t.key === a)).map((x) => [x.session, x.claude]), [[S, 'busy']]);
  unreg(6601);
  // never sent: after two hours nobody will — the session is closed, not "starting" and not nothing at all (the Claude
  // review section read "Claude is checking" for good)
  const [c] = addTasks(['todo']);
  tasks.moveLaunched(rowsOf([c]), null, 'desktop');
  db.prepare("UPDATE task_events SET created_at = datetime('now', '-3 hours') WHERE task_id = ?").run(tasks.resolveTask(c).id);
  db.prepare("UPDATE tasks SET updated_at = datetime('now', '-3 hours') WHERE id = ?").run(tasks.resolveTask(c).id);
  assert.deepEqual(await badges([c]), { [c]: 'gone' });
  d = await now.nowRuns(() => false);
  const left = d.runs.find((x) => x.tasks.some((t) => t.key === c));
  assert.deepEqual([left.session, left.claude, left.stale, left.tasks.find((t) => t.key === c).stale_h], [null, 'gone', true, 3]);
});

test('a start in the Claude app stops waiting once the task moves on, whoever moves it', async () => {
  const S = 'b9b9b9b9-0000-4000-8000-000000000009';
  reg(9901, S, 'busy');
  // the session of the app goes straight to Doing without saying prep first: it is on it, not "starting"
  const [a] = addTasks(['todo']);
  tasks.moveLaunched(rowsOf([a]), null, 'desktop');
  assert.equal((await move(a, 'doing', S)).statusCode, 200);
  assert.deepEqual(await badges([a], aliveOnly(9901)), { [a]: 'busy' });
  // a start nobody took, the task back in To do, and later taken by kb: the old start says nothing any more
  const [b] = addTasks(['todo']);
  tasks.moveLaunched(rowsOf([b]), null, 'desktop');
  assert.equal((await move(b, 'todo')).statusCode, 200);
  assert.equal((await move(b, 'prep', S)).statusCode, 200);
  assert.deepEqual(await badges([b], aliveOnly(9901)), {}, 'the task is "starting" again by a start that ended long ago'); // the session is on a
  assert.ok(!(await live.liveTasks(aliveOnly(9901))).some((x) => x.claude === 'starting' && [a, b].includes(x.key)));
  assert.equal((await live.liveTasks(aliveOnly(9901))).filter((x) => x.key === a).length, 1, 'a task has two badges');
  unreg(9901);
});

test('a look at the states asked for while one runs comes after it — a start made meanwhile is not left out', async () => {
  const [a] = addTasks(['todo']);
  const S = 'c0c0c0c0-0000-4000-8000-00000000000c';
  for (const t of rowsOf([a])) sessions.tieLaunched(t.id, S);
  live.liveTick(); // this one has read the tasks in work before the start below
  const after = heard((d) => d.tasks.some((x) => x.key === a && x.claude === 'starting'));
  tasks.moveLaunched(rowsOf([a]), S, 'board');
  live.liveTick();
  await after;
});

test('Claude now: a run ▶ started inside the board is live and starting until its Claude shows up', async () => {
  const [a, b] = addTasks(['todo', 'todo']);
  const S = 'a7a7a7a7-0000-4000-8000-000000000007';
  for (const t of rowsOf([a, b])) sessions.tieLaunched(t.id, S);
  tasks.moveLaunched(rowsOf([a, b]), S, 'board');
  const run = (await now.nowRuns(() => false)).runs.find((x) => x.session === S);
  assert.deepEqual([run.claude, run.stale, run.tasks.map((t) => [t.key, t.status, t.focus])], ['starting', false, [[a, 'prep', true], [b, 'prep', false]]]);
});

// two minutes of the grace; the board asks its terminal (src/phantom.js, here a stand-in). A session the board did
// not start has no terminal of the board, and nothing is asked of tmux for it.
test('a fresh start whose terminal in the board is closed is a closed session at once — on the card and in Claude now', async () => {
  const [a] = addTasks(['todo']);
  const [b] = addTasks(['todo']);
  const S = 'abab0000-0000-4000-8000-0000000000a1';
  const T = 'abab0000-0000-4000-8000-0000000000a2';
  sessions.markBoardSession(S);
  sessions.tieLaunched(tasks.resolveTask(a).id, S);
  tasks.moveLaunched(rowsOf([a]), S, 'board');
  sessions.tieLaunched(tasks.resolveTask(b).id, T);
  tasks.moveLaunched(rowsOf([b]), T, 'terminal');
  const asked = [];
  const pane = (st) => async (sid) => { asked.push(sid); return st; };
  const states = async (paneOf, isAlive = () => false) => Object.fromEntries((await live.liveTasks(isAlive, paneOf)).filter((x) => [a, b].includes(x.key)).map((x) => [x.key, x.claude]));
  const runs = async (paneOf) => Object.fromEntries((await now.nowRuns(() => false, paneOf)).runs.filter((x) => [S, T].includes(x.session)).map((x) => [x.session, [x.claude, x.stale]]));
  assert.deepEqual(await states(pane({ dead: false })), { [a]: 'starting', [b]: 'starting' }, 'a Claude still up in its terminal reads as closed');
  assert.deepEqual(await states(pane({ dead: true, exit: 1 })), { [a]: 'gone', [b]: 'starting' }, 'an exited Claude of the board reads as starting');
  assert.deepEqual(await states(pane(null)), { [a]: 'gone', [b]: 'starting' }, 'a terminal that is not there at all reads as starting');
  assert.deepEqual(await runs(pane({ dead: true, exit: 1 })), { [S]: ['gone', true], [T]: ['starting', false] });
  assert.deepEqual(await runs(pane({ dead: true, exit: 143 })), { [S]: ['gone', false], [T]: ['starting', false] });
  assert.ok(asked.includes(S) && !asked.includes(T), `tmux was asked of a session the board did not start: ${asked}`);
  // up in Claude Code's registry, the registry says it, whatever the terminal: tmux is not asked
  reg(7701, S, 'busy');
  asked.length = 0;
  assert.equal((await states(pane({ dead: true }), aliveOnly(7701)))[a], 'busy');
  assert.ok(!asked.includes(S), 'tmux was asked of a session the registry has alive');
  unreg(7701);
});

/* ── the page ───────────────────────────────────────────────────────────── */
const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
const piece = (src, head, end = '\n}\n') => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  return src.slice(at, src.indexOf(end, at) + end.length).replace(/^export /, '');
};

test('▶ sends the keys of its tasks whichever way Claude is started — and copying sends nothing', async () => {
  for (const setting of ['board', 'desktop', 'terminal', 'copy']) {
    const calls = [];
    const box = {
      api: async (method, path, body) => { calls.push({ method, path, body }); return path === '/api/launch' && method === 'GET' ? { board: true, desktop: true, terminal: true, cli: true } : { ok: true, keys: body?.keys }; },
      getSetting: (k) => ({ launch: setting, permission: 'auto' })[k], pickedSetting: (k) => ({ launch: setting, permission: 'auto' })[k], launchPick, boardOnly, effortOf, startEffort, checksOnly, state: {},
      copyText: async () => true, tr: (s) => s, styledAlert() {}, openTerminalOf() {}, askProjectFolder: async () => false,
      setTimeout: () => 0, ic: () => '', promptHere: (s) => s,
    };
    vm.runInNewContext([
      'var launchAvail = null;',
      piece(sse, 'export async function loadLaunchOptions('),
      piece(sse, 'async function launchMode('),
      piece(sse, 'function flashButton('),
      piece(sse, 'async function postLaunch('),
      piece(sse, 'const BOARD_WHY = {', '\n};\n'),
      piece(sse, 'export async function launchInClaude('),
    ].join('\n'), box);
    const btn = { innerHTML: '', title: '', textContent: '', classList: { toggle() {}, remove() {} } };
    await box.launchInClaude({ text: 'Run the kanban skill\nST-1\nST-2', project: 'site', keys: ['ST-1', 'ST-2'], btn });
    const started = calls.filter((c) => c.method === 'POST' && c.path === '/api/launch');
    if (setting === 'copy') assert.equal(started.length, 0, 'copying the prompt started Claude');
    else assert.deepEqual(started.map((c) => [c.body.mode, c.body.keys]), [[setting, ['ST-1', 'ST-2']]], `${setting}: the server cannot move the tasks it is not told about`);
  }
});

test('the card and Claude now say "starting" in the board\'s words', () => {
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const nowJs = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const box = { esc: (s) => String(s), tr: (s) => `«${s}»`, hasAsk: () => false, WORKING: new Set(['prep', 'doing', 'deploy']), state: { live: { 7: { claude: 'starting' } } }, waited: () => '' };
  vm.runInNewContext([piece(board, 'const LIVE_BADGE = {', '\n};\n'), piece(board, 'function liveBadge('), piece(nowJs, 'function runBadge(')].join('\n'), box);
  const card = box.liveBadge({ id: 7, status: 'prep' });
  assert.match(card, /^<span class="card-live live-start" title="«Claude has been started on it and has not taken it yet»"><span class="live-dot"><\/span>«starting»<\/span>$/);
  assert.equal(box.liveBadge({ id: 7, status: 'todo' }), '', 'a card out of work got a badge');
  const run = box.runBadge({ claude: 'starting', tasks: [{ stale_h: 0 }] });
  assert.match(run, /class="card-live live-start" title="«Claude has been started on these tasks and has not taken them yet»".*«starting»/);
  for (const s of ['starting', 'Claude has been started on it and has not taken it yet', 'Claude has been started on these tasks and has not taken them yet']) {
    assert.ok(core.includes(`${/^\w+$/.test(s) ? s : `'${s}'`}: '`), `no Russian for "${s}"`);
  }
});

test('the card and Claude now say a start nobody sent in the Claude app waits to start there, in the board\'s words', () => {
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const nowJs = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const box = { esc: (s) => String(s), tr: (s) => `«${s}»`, hasAsk: () => false, WORKING: new Set(['prep', 'doing', 'deploy']), state: { live: { 7: { claude: 'unsent' } } }, waited: () => '' };
  vm.runInNewContext([piece(board, 'const LIVE_BADGE = {', '\n};\n'), piece(board, 'function liveBadge('), piece(nowJs, 'function runBadge(')].join('\n'), box);
  assert.equal(box.liveBadge({ id: 7, status: 'prep' }),
    '<span class="card-live live-wait" title="«The prompt is in the Claude app — press Enter there to start Claude»"><span class="live-dot"></span>«waiting to start in the app»</span>');
  assert.match(box.runBadge({ claude: 'unsent', tasks: [{ stale_h: 0 }] }), /class="card-live live-wait" title="«The prompt is in the Claude app — press Enter there to start Claude»".*«waiting to start in the app»/);
  for (const s of ['waiting to start in the app', 'The prompt is in the Claude app — press Enter there to start Claude']) assert.ok(core.includes(`'${s}': '`), `no Russian for "${s}"`);
});

async function withTerminal(script, fn) {
  const term = process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator';
  writeFileSync(join(bin, term), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, term), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  delete process.env.KB_LAUNCH_DRYRUN;
  try { return await fn(); } finally { process.env.PATH = path; process.env.KB_LAUNCH_DRYRUN = '1'; }
}

test('a second ▶ in the Terminal does not hand another Claude the tasks the first one holds — a gone one\'s it takes over', async () => {
  const [x] = addTasks(['todo']);
  await withTerminal('exit 0', async () => {
    const first = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
    assert.deepEqual(first.prep, [x]);
    const second = await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().prep, [], 'a task in prep was moved again');
    assert.equal((await move(x, 'prep', second.json().session)).statusCode, 409, 'the second Claude was let to keep a task the first one holds');
    assert.equal((await move(x, 'prep', first.session)).statusCode, 200, 'the first Claude lost its task');
    // the first Claude is gone: its start is long past and it is not in Claude Code's registry — a new ▶ takes the task over
    db.prepare("UPDATE task_events SET created_at = datetime('now', '-10 minutes') WHERE session_id = ?").run(first.session);
    db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-10 minutes') WHERE session_id = ?").run(first.session);
    const third = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
    assert.equal((await move(x, 'prep', third.session)).statusCode, 200, 'a card left in prep by a Claude that is gone could not be taken over');
  });
});

test('a Claude of the board holds its task while tmux does not answer — a second ▶ takes it only once tmux says the session is not there', async () => {
  const [x] = addTasks(['todo']);
  const HOLDER = 'e5e5e5e5-0000-4000-8000-000000000564';
  sessions.markBoardSession(HOLDER);
  tasks.moveLaunched(rowsOf([x]), HOLDER, 'board');
  // long past its start, and not in Claude Code's registry: only its terminal can say it is alive
  db.prepare("UPDATE task_events SET created_at = datetime('now', '-10 minutes') WHERE session_id = ?").run(HOLDER);
  db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-10 minutes') WHERE session_id = ?").run(HOLDER);
  const said = join(tmp, 'tmux-says');
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\ncase "$(cat '${said}')" in\n  late) kill -TERM $$;;\n  alive) echo '0||45|123|';;\n  dead) echo '1|0|45|123|';;\n  gone) echo "can't find session: =kb-x" >&2; exit 1;;\nesac\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const socket = process.env.KB_TMUX_SOCKET;
  process.env.KB_TMUX_SOCKET = `kb-launch-prep-${process.pid}`;
  try {
    await withTerminal('exit 0', async () => {
      writeFileSync(said, 'late');
      const second = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
      assert.equal((await move(x, 'prep', second.session)).statusCode, 409, 'a tmux that did not answer handed the live Claude\'s task to a second one');
      assert.equal((await move(x, 'prep', HOLDER)).statusCode, 200, 'the Claude of the board lost its task');
      writeFileSync(said, 'alive');
      const live = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
      assert.equal((await move(x, 'prep', live.session)).statusCode, 409, 'a live Claude of the board lost its task to a second one');
      // the Claude of the board exited and its pane stays on the screen (remain-on-exit): it holds nothing any more
      writeFileSync(said, 'dead');
      const after = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
      assert.equal((await move(x, 'prep', after.session)).statusCode, 200, 'a Claude of the board that exited still held its task');
      db.prepare("UPDATE task_events SET created_at = datetime('now', '-10 minutes') WHERE session_id = ?").run(after.session);
      db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-10 minutes') WHERE session_id = ?").run(after.session);
      sessions.markBoardSession(after.session);
      writeFileSync(said, 'gone');
      const third = (await post({ mode: 'terminal', text: `Do ${x}`, project: 'site', keys: [x] })).json();
      assert.equal((await move(x, 'prep', third.session)).statusCode, 200, 'a task whose Claude of the board is gone could not be taken over');
    });
  } finally {
    rmSync(join(bin, 'tmux'), { force: true });
    if (socket === undefined) delete process.env.KB_TMUX_SOCKET; else process.env.KB_TMUX_SOCKET = socket;
  }
});

test('▶ inside the board does not start a second Claude while tmux does not answer about the first one', async () => {
  const [x] = addTasks(['todo']);
  const HOLDER = 'e5e5e5e5-0000-4000-8000-000000000565';
  sessions.markBoardSession(HOLDER);
  tasks.moveLaunched(rowsOf([x]), HOLDER, 'board');
  const said = join(tmp, 'tmux-says-565');
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\ncase "$(cat '${said}')" in\n  late) kill -TERM $$;;\n  alive) echo '0||45|123|';;\n  dead) echo '1|0|45|123|';;\n  gone) echo "can't find session: =kb-x" >&2; exit 1;;\n  exiting) echo "lost server" >&2; exit 1;;\nesac\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const start = () => post({ mode: 'board', text: `Do ${x}`, project: 'site', keys: [x] });
  try {
    writeFileSync(said, 'late');
    const late = await start();
    assert.equal(late.statusCode, 409, `a tmux that did not answer let a second Claude start: ${late.body}`);
    assert.equal(late.json().reason, 'tmux-slow');
    assert.deepEqual(late.json().keys, [x], 'the refusal does not name the tasks the page asks to start again');
    assert.equal(late.json().fallback, undefined, 'another way of starting would start the second Claude all the same');
    writeFileSync(said, 'alive');
    assert.deepEqual((await start()).json().running, [x]);
    writeFileSync(said, 'dead');
    assert.equal((await start()).statusCode, 200, 'a Claude of the board that exited still blocked a new start');
    writeFileSync(said, 'gone');
    assert.equal((await start()).statusCode, 200, 'a terminal tmux says is not there blocked a new start');
    writeFileSync(said, 'exiting');
    assert.equal((await start()).statusCode, 200, 'a tmux server on its way out refused the start as one that did not answer');
  } finally {
    process.env.PATH = path;
    rmSync(join(bin, 'tmux'), { force: true });
  }
  const page = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(page, /'tmux-slow':/, 'the page has no words of its own for the refusal');
  // reads English on the Russian board, and nothing said so
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const block = page.slice(page.indexOf('const BOARD_WHY = {'), page.indexOf('\n};', page.indexOf('const BOARD_WHY = {')));
  const lines = [...block.matchAll(/^\s*'[\w-]+':\s*(['"])(.+)\1,\s*$/gm)].map((m) => m[2]);
  assert.ok(lines.length >= 5, `the reasons of BOARD_WHY were not read: ${lines.length}`);
  for (const line of [...lines, 'Tasks:']) assert.ok(core.includes(`'${line}':`) || core.includes(`"${line}":`), `no Russian for: ${line}`);
});

test('two ▶ in the Terminal at once are one start: the second is told Claude is being started, nothing opens twice', async () => {
  const [y] = addTasks(['todo']);
  const said = join(tmp, 'slow-terminal.log');
  await withTerminal(`printf 'opened\\n' >> '${said}'; sleep 0.4`, async () => {
    const body = { mode: 'terminal', text: `Do ${y}`, project: 'site', keys: [y] };
    const [a, b] = await Promise.all([post(body), post(body)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} ${b.body}`);
    const refused = [a, b].find((r) => r.statusCode === 409).json();
    assert.equal(refused.reason, 'starting');
    assert.equal(readFileSync(said, 'utf8'), 'opened\n', 'the Terminal opened twice');
  });
  const { refusalText } = await import('../public/js/unsaved.js');
  assert.equal(refusalText({ status: 409, message: 'x', body: { reason: 'starting' } }).reason, 'Claude is already being started on these tasks');
});

test('the work feed: a board session whose kb sends no session id still borrows its unsigned moves after ▶\'s move', async () => {
  const OLDKB = '0b0b0b0b-1111-4111-8111-111111111111';
  const [z] = addTasks(['todo']);
  sessions.markBoardSession(OLDKB);
  assert.deepEqual(tasks.moveLaunched(rowsOf([z]), OLDKB, 'board'), [z]);
  assert.equal((await move(z, 'doing')).statusCode, 200);
  assert.deepEqual(feed.sessionEvents(OLDKB).map((e) => e.status), ['prep', 'doing'],
    'the move ▶ made for the session made it stop borrowing the moves its old kb wrote without an id (CK-471)');
  // a session with a move of its own still borrows nothing
  assert.equal((await move(z, 'review', OLDKB)).statusCode, 200);
  assert.deepEqual(feed.sessionEvents(OLDKB).map((e) => e.status), ['prep', 'review']);
});

test('a task deleted while Claude is being started does not fail the start: Claude is up, the rest is in prep', async () => {
  const [gone, kept] = addTasks(['todo', 'todo']);
  const opened = join(tmp, 'opening-terminal');
  await withTerminal(`printf 'x' > '${opened}'; sleep 0.5`, async () => {
    const pending = post({ mode: 'terminal', text: `Do ${gone} ${kept}`, project: 'site', keys: [gone, kept] });
    for (let i = 0; i < 200 && !existsSync(opened); i++) await new Promise((d) => { setTimeout(d, 10); });
    assert.ok(existsSync(opened), 'the Terminal was never opened');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/tasks/${gone}` })).statusCode, 204);
    const r = await pending;
    assert.equal(r.statusCode, 200, `the start failed after the Claude it started was up: ${r.body}`);
    assert.deepEqual(r.json().prep, [kept]);
  });
  assert.equal(statusOf(kept), 'prep');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_sessions s LEFT JOIN tasks t ON t.id = s.task_id WHERE t.id IS NULL').get().n, 0);
});
