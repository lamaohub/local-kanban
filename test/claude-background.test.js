// every 30 s: "1 shell still running") is idle in Claude Code's registry, and "Claude now" showed nothing, though its
// terminal in the card worked on. Such a run — of the board's own terminal, busy, or with commands running in the
// background on its screen — is "now", with its handed-in tasks, and not "done": one run is never in both sections.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import Fastify from 'fastify';

const BG = '11111111-1111-4111-8111-111111111111';   // the board's, idle, a shell in the background
const BUSY = '22222222-2222-4222-8222-222222222222'; // the board's, busy in its registry
const DONE = '33333333-3333-4333-8333-333333333333'; // the board's, idle, nothing in the background
const ELSE = '44444444-4444-4444-8444-444444444444'; // not the board's (Terminal, app), busy
let app, tmp, claude, db, now, live, phantom, child;
// live processes for the registry: the route asks the system itself whether a session's process is alive
const PIDS = {};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  now = await import('../src/claude-now.js');
  live = await import('../src/claude-live.js');
  phantom = await import('../src/phantom.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','BG','Demo',5)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get().id;
  for (const no of [1, 2, 3, 4]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
  const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': sid }, payload: { status } });
  for (const [key, sid] of [['BG-1', BG], ['BG-2', BUSY], ['BG-3', DONE], ['BG-4', ELSE]]) {
    for (const st of ['prep', 'doing', 'review']) assert.equal((await move(key, st, sid)).statusCode, 200);
  }
  for (const sid of [BG, BUSY, DONE]) db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(sid);
  const reg = (pid, sessionId, status) => writeFileSync(join(claude, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, status, statusUpdatedAt: Date.now() }));
  child = spawn('sleep', ['60'], { stdio: 'ignore' });
  Object.assign(PIDS, { [BG]: process.pid, [BUSY]: process.ppid, [DONE]: child.pid, [ELSE]: 1 });
  reg(PIDS[BG], BG, 'idle'); reg(PIDS[BUSY], BUSY, 'busy'); reg(PIDS[DONE], DONE, 'idle'); reg(PIDS[ELSE], ELSE, 'busy');
});

after(async () => {
  child?.kill();
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const alive = (pid) => Object.values(PIDS).includes(pid);
const sessions = (runs) => runs.map((r) => [r.session, r.claude]).sort();

test('the count of background commands is read off the lines under the input box', () => {
  const box = (status) => ['● The check runs in the background.', '', '✻ Baked for 2m 7s · done 2:53 PM · 1 shell', '  still running', '', `${'─'.repeat(38)} FR-28 ─`, '❯ ', '─'.repeat(45), '  ⬆ /gsd-update │ Opus 5.5 (1M context) │ …', `  ⏵⏵ auto mode on${status} · ← for agents`].join('\n');
  assert.equal(phantom.backgroundOnScreen(box(' · 1 shell')), true);
  assert.equal(phantom.backgroundOnScreen(box(' · 2 shells')), true);
  assert.equal(phantom.backgroundOnScreen(box('')), false, 'a Claude at its prompt with nothing running is taken for one at work');
  // Claude Code drops that hint and the count fits — both forms off the owner's live terminals (Claude Code 2.1.296)
  const live = (status) => [`${'─'.repeat(36)} VT-674 ─`, '❯ ', '─'.repeat(45), '  ⬆ /gsd-update │ Opus 5.5 (1M context) │ …', `  ⏵⏵ auto mode on${status}`].join('\n');
  assert.equal(phantom.backgroundOnScreen(live(' · 2 shells · ← for agents')), true);
  assert.equal(phantom.backgroundOnScreen(live(' (shift+tab to cycle) · ←…')), false);
  assert.equal(phantom.backgroundOnScreen('I ran 3 shells earlier.\n' + '\n'.repeat(6) + '❯ \n' + '─'.repeat(45) + '\n  ⏵⏵ auto mode on'), false, 'words of Claude far above the box count');
});

// that handed its task in hours ago and waits at its prompt; the owner asked why the task was in Review then
test('the terminal says what its Claude does: at work, commands in the background, a question, the limit, or waiting', async () => {
  const box = (status, above = ['✻ Baked for 2m 7s · done 2:53 PM']) => [...above, '', `${'─'.repeat(38)} FR-28 ─`, '❯ ', '─'.repeat(45), `  ⏵⏵ auto mode on${status} · ← for agents`].join('\n');
  assert.equal(await phantom.terminalActivity(null, box('')), 'idle', 'a Claude waiting at its prompt is said to work');
  assert.equal(await phantom.terminalActivity(null, box(' · 1 shell')), 'background');
  assert.equal(await phantom.terminalActivity(null, box('', ['✻ Thinking… (12s · esc to interrupt)'])), 'busy');
  assert.equal(await phantom.terminalActivity(null, box(' · ⚠ Usage limit reached · limit resets 12:50am')), 'limit');
  assert.equal(await phantom.terminalActivity(null, ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit', '', 'Enter to confirm · Esc to cancel'].join('\n')), 'question');
  // the registry, read by the pid of the program in the pane, decides over the screen
  assert.equal(await phantom.terminalActivity(PIDS[BUSY], box('', ['✻ Thinking… (12s · esc to interrupt)'])), 'busy', 'a Claude busy in its registry is said to wait');
  // busy for a background agent), and Claude waits at its prompt
  assert.equal(await phantom.terminalActivity(PIDS[BUSY], box('')), 'background', 'a Claude whose turn is over is said to be at work on a turn');
  assert.equal(await phantom.terminalActivity(PIDS[DONE], box('', ['✻ Thinking… (12s · esc to interrupt)'])), 'idle', 'an idle registry is taken for work');
  assert.equal(await phantom.terminalActivity(PIDS[BG], box(' · 1 shell')), 'background');
  const own = async () => true;
  assert.equal(await phantom.terminalActivity(PIDS[BG], box(' · 1 shell'), null, own), 'own', 'a Claude waiting for its own command is said to wait for you');
  assert.equal(await phantom.terminalActivity(PIDS[BUSY], box(''), null, own), 'own', 'busy with handed-off work of its own is said to wait for you');
  assert.equal(await phantom.terminalActivity(PIDS[DONE], box(''), null, own), 'idle', 'a Claude with nothing in the background is said to work');
  // a Claude its registry calls waiting asks something the screen does not show as a question
  const file = join(claude, 'sessions', `${PIDS[DONE]}.json`);
  writeFileSync(file, JSON.stringify({ pid: PIDS[DONE], sessionId: DONE, status: 'waiting', statusUpdatedAt: 1000 }));
  try { assert.equal(await phantom.terminalActivity(PIDS[DONE], box('')), 'question', 'a Claude waiting for an answer is said to work'); }
  finally { writeFileSync(file, JSON.stringify({ pid: PIDS[DONE], sessionId: DONE, status: 'idle', statusUpdatedAt: 1000 })); }
  const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const words = [...src.match(/const TERM_ACTIVITY = \{([\s\S]*?)\};/)[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(words.map((w) => w[0]).sort(), ['background', 'busy', 'idle', 'limit', 'own', 'question']);
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const [, w] of words) assert.ok(core.includes(`'${w}': '`), `no Russian for "${w}"`);
  assert.doesNotMatch(src, /tr\('Claude works in the background'\)/, 'a Claude waiting at its prompt is still said to work in the background');
  assert.match(src, /tr\(TERM_ACTIVITY\[r\.activity\] \|\|/);
});

test('a run of the board still at work is in Claude now and not in Claude done', async () => {
  await live.refreshLive(alive, async () => ({ live: [BG, BUSY, DONE], questions: [], background: [BG] }));
  assert.deepEqual([...live.currentBackground()], [BG]);
  const move = (status) => app.inject({ method: 'PATCH', url: '/api/tasks/BG-1', headers: { 'x-claude-session': BG }, payload: { status } });
  assert.equal((await move('doing')).statusCode, 200); // sent back to work, taken by its Claude
  await live.refreshLive(alive, async () => ({ live: [BG, BUSY, DONE], questions: [], background: [BG], limited: [] }));
  // commands in the background or not — the badge says so and marks the background
  const bg1 = live.currentLive().find((t) => t.key === 'BG-1');
  assert.deepEqual([bg1?.claude, bg1?.background], ['idle', true], 'a card says "working" of a Claude at its prompt with commands in the background');
  const own = (sid) => async (s) => s === sid;
  const mine = (await live.liveTasks(alive, undefined, undefined, undefined, undefined, own(BG))).find((t) => t.key === 'BG-1');
  assert.deepEqual([mine?.claude, mine?.background], ['background', undefined], 'a Claude waiting for its own command is said to wait for you');
  const other = (await live.liveTasks(alive, undefined, undefined, undefined, undefined, own(BUSY))).find((t) => t.key === 'BG-1');
  assert.equal(other?.claude, 'idle', 'the work of another session counted for this one');
  const run = (await now.nowRuns(alive, undefined, own(BG))).runs.find((r) => r.session === BG);
  assert.deepEqual([run?.claude, run?.background], ['background', undefined], 'Claude now says it waits for you');
  assert.equal((await move('review')).statusCode, 200);
  await live.refreshLive(alive, async () => ({ live: [BG, BUSY, DONE], questions: [], background: [BG] }));
  const d = await now.nowRuns(alive);
  assert.deepEqual(sessions(d.runs), [[BG, 'background'], [BUSY, 'busy']], 'a board run at work is missing, or a finished one / another one is shown');
  const bg = d.runs.find((r) => r.session === BG);
  assert.deepEqual(bg.tasks.map((t) => [t.key, t.status]), [['BG-1', 'review']]);
  assert.equal(bg.stale, false, 'a run at work is among the ones nobody leads');
  assert.equal(d.tasks_n, 0, 'tasks_n counts tasks in work only');
  const done = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.deepEqual(done.runs.map((r) => r.session).sort(), [DONE, ELSE].sort(), 'a run still at work is in Claude done too, or a finished one is not');
  assert.deepEqual(now.doneRuns().runs.map((r) => r.session).sort(), [BG, BUSY, DONE, ELSE].sort(), 'without `active` every run that handed in is done');
});

// "waiting for you", and the run was gone from Claude now: a Claude of the board at its prompt with a task of its run in
// Review waits for the person, and stays "now" — until LEFTOVER_MS at its prompt, or its tasks accepted
test('the background ends — the run waits for you in Claude now; two hours at its prompt, and it is done', async () => {
  const file = join(claude, 'sessions', `${PIDS[BG]}.json`);
  const put = (status, since) => writeFileSync(file, JSON.stringify({ pid: PIDS[BG], sessionId: BG, status, statusUpdatedAt: since }));
  put('idle', Date.now() - 60_000);
  assert.equal(await live.refreshLive(alive, async () => ({ live: [BG, BUSY, DONE], questions: [], background: [] })), true, 'the end of the background work did not reach the page');
  let d = await now.nowRuns(alive);
  assert.deepEqual(sessions(d.runs), [[BG, 'idle'], [BUSY, 'busy']], 'a Claude waiting at its prompt after its hand-in is gone from Claude now');
  assert.ok(d.runs.find((r) => r.session === BG).since > 0, 'the wait is not dated');
  let done = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.ok(!done.runs.some((r) => r.session === BG), 'a run waiting for you is in Claude done too');
  assert.ok(done.runs.some((r) => r.session === DONE), 'a Claude at its prompt for hours is still "now"'); // DONE: idle since long ago
  // a Claude the registry calls waiting — the same
  put('waiting', Date.now() - 60_000);
  assert.deepEqual(sessions((await now.nowRuns(alive)).runs).find((r) => r[0] === BG), [BG, 'waiting']);
  // its tasks all accepted: done, whatever its Claude does
  const move = (status) => app.inject({ method: 'PATCH', url: '/api/tasks/BG-1', payload: { status } });
  put('idle', Date.now() - 60_000);
  assert.equal((await move('done')).statusCode, 200);
  try {
    assert.ok(!sessions((await now.nowRuns(alive)).runs).some((r) => r[0] === BG), 'a run whose tasks are all accepted waits for you');
  } finally { assert.equal((await move('review')).statusCode, 200); }
  const bgTask = db.prepare("SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix = 'BG' AND t.task_no = 1").get().id;
  const later = '99999999-9999-4999-8999-999999999999';
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now', '+1 minute'), datetime('now', '+1 minute'))").run(bgTask, later);
  // and the session keeps a task of its own, accepted — its run is there to be shown
  const pidBg = db.prepare("SELECT id FROM projects WHERE prefix = 'BG'").get().id;
  const kept = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 9, 'Kept', 'done')").run(pidBg).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))").run(kept, BG);
  try {
    assert.ok(!sessions((await now.nowRuns(alive)).runs).some((r) => r[0] === BG), 'a Claude whose Review task another session took up waits for you');
  } finally {
    db.prepare('DELETE FROM task_sessions WHERE session_id = ? OR task_id = ?').run(later, kept);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(kept);
  }
  // two hours at its prompt: the run is done
  put('idle', Date.now() - live.LEFTOVER_MS - 60_000);
  d = await now.nowRuns(alive);
  assert.deepEqual(sessions(d.runs), [[BUSY, 'busy']]);
  done = (await app.inject({ method: 'GET', url: '/api/done' })).json();
  assert.ok(done.runs.some((r) => r.session === BG));
  put('idle', Date.now());
  // and a Claude that exited with a shell still on its last screen is no run at work
  await live.refreshLive(() => false, async () => ({ live: [BG], questions: [], background: [BG] }));
  assert.deepEqual((await now.nowRuns(() => false)).runs, []);
});

// answer, and Claude now was empty. A task its Claude put back to To do waits for the person as one in Review does; one
// the person moved there afterwards does not.
test('a Claude at its prompt with the task it put back to To do waits for you in Claude now', async () => {
  const file = join(claude, 'sessions', `${PIDS[BG]}.json`);
  writeFileSync(file, JSON.stringify({ pid: PIDS[BG], sessionId: BG, status: 'idle', statusUpdatedAt: Date.now() - 60_000 }));
  await live.refreshLive(alive, async () => ({ live: [BG, BUSY, DONE], questions: [], background: [], limited: [] }));
  const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: sid ? { 'x-claude-session': sid } : {}, payload: { status } });
  const pidBg = db.prepare("SELECT id FROM projects WHERE prefix = 'BG'").get().id;
  const ask = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 7, 'Ask', 'todo')").run(pidBg).lastInsertRowid;
  assert.equal((await move('BG-1', 'done')).statusCode, 200); // its Review task accepted: only the To do one is left
  try {
    assert.ok(!sessions((await now.nowRuns(alive)).runs).some((r) => r[0] === BG), 'a run whose tasks are all accepted waits for you');
    for (const st of ['prep', 'todo']) assert.equal((await move('BG-7', st, BG)).statusCode, 200);
    const run = (await now.nowRuns(alive)).runs.find((r) => r.session === BG);
    assert.ok(run, 'a Claude waiting for the answer to the task it put back to To do is gone from Claude now');
    assert.equal(run.claude, 'idle');
    assert.deepEqual(run.tasks.map((t) => [t.key, t.status]), [['BG-1', 'done'], ['BG-7', 'todo']], 'the run shows its hand-ins and the task it put back');
    // the person moved it on: To do no longer says its Claude waits
    for (const st of ['backlog', 'todo']) assert.equal((await move('BG-7', st)).statusCode, 200);
    assert.ok(!sessions((await now.nowRuns(alive)).runs).some((r) => r[0] === BG), 'a task the person moved to To do keeps its old Claude in Claude now');
    const other = '88888888-8888-4888-8888-888888888888';
    for (const [st, sid] of [['backlog'], ['todo', other]]) assert.equal((await move('BG-7', st, sid)).statusCode, 200);
    assert.ok(!sessions((await now.nowRuns(alive)).runs).some((r) => r[0] === BG), 'a task another Claude moved to To do keeps the old Claude in Claude now');
  } finally {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(ask);
    assert.equal((await move('BG-1', 'review')).statusCode, 200);
  }
});

test('only a terminal the last look saw alive is asked about: no registry for the sessions of long ago', async () => {
  await live.refreshLive(alive, async () => ({ live: [], questions: [], background: [BG] }));
  assert.deepEqual([...(await now.activeBoardSessions(alive, () => { throw new Error('the registry was read'); }))], []);
});

// whose Claude of the board went on past handing its tasks in (busy, or commands in the background) stayed orange while
// "Claude now" showed it at work (the owner's screenshot: Claude Kanban at work, all its tasks in Review). The watch
// names such projects; a session that is not the board's, or one idle with nothing in the background, does not count.
test('the projects of a Claude of the board at work past its tasks in work go with task.live and /api/live', async () => {
  const look = (live, background) => async () => ({ live, questions: [], background, limited: [] });
  await live.refreshLive(alive, look([BG, BUSY, DONE], [BG]));
  assert.deepEqual(live.currentWorkProjects(), ['demo'], 'a Claude of the board at work past its tasks does not mark its project');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/live' })).json().projects, ['demo']);
  await live.refreshLive(alive, look([DONE], []));
  assert.deepEqual(live.currentWorkProjects(), [], 'an idle Claude with nothing in the background marks its project');
  await live.refreshLive(alive, look([BG], []));
  assert.deepEqual(live.currentWorkProjects(), [], 'a Claude idle at its prompt is taken for one at work');
  await live.refreshLive(alive, look([BG], [BG]));
  assert.deepEqual(live.currentWorkProjects(), ['demo']);
  await live.refreshLive(alive, look([], []));
});

// board took the word it did not know for "busy", and "Claude now" said "working" over runs whose tasks were all Done —
// three terminals idle for two to four days, their background commands loops `until ! pgrep -f …` that find themselves.
test('a `shell` Claude works in the background, not busy — and hours of it past its tasks are a leftover, not work', async () => {
  const file = join(claude, 'sessions', `${PIDS[BG]}.json`);
  const put = (status, since) => writeFileSync(file, JSON.stringify({ pid: PIDS[BG], sessionId: BG, status, statusUpdatedAt: since }));
  const look = (background) => async () => ({ live: [BG, DONE], questions: [], background, limited: [] });
  const old = () => Date.now() - live.LEFTOVER_MS - 60_000;
  const box = ['✻ Cooked for 5m 38s · done 2:28 PM · 2 shells', '  still running', '', `${'─'.repeat(38)} VT-669 ─`, '❯ ', '─'.repeat(45), '  ⏵⏵ auto mode on · ← for agents'].join('\n');
  try {
    assert.equal(live.stateOf({ alive: true, status: 'shell' }), 'background');
    assert.equal(live.stateOf({ alive: true, status: 'compacting' }), 'busy', 'a status still unknown is a live session at work, as before');
    put('shell', Date.now() - 60_000);
    await live.refreshLive(alive, look([])); // the registry alone says it: the screen line is not needed
    assert.deepEqual(sessions((await now.nowRuns(alive)).runs), [[BG, 'background']], 'a `shell` Claude is said to be busy, or missing');
    assert.deepEqual(live.currentWorkProjects(), ['demo']);
    assert.equal(await phantom.terminalActivity(PIDS[BG], box), 'background', 'the Terminal tab says a `shell` Claude is at work on a turn');
    put('shell', old());
    await live.refreshLive(alive, look([BG]));
    assert.deepEqual((await now.nowRuns(alive)).runs, [], 'a Claude at its prompt for hours past its tasks, a loop left in the background, is said to work');
    assert.deepEqual(live.currentWorkProjects(), [], 'its project is lit as at work');
    assert.ok((await app.inject({ method: 'GET', url: '/api/done' })).json().runs.some((r) => r.session === BG), 'the run is in neither section');
    // an older Claude Code: idle in the registry, the shells on the screen only — the same rule
    put('idle', old());
    await live.refreshLive(alive, look([BG]));
    assert.deepEqual((await now.nowRuns(alive)).runs, []);
    put('idle', Date.now() - 60_000);
    await live.refreshLive(alive, look([BG]));
    assert.deepEqual(sessions((await now.nowRuns(alive)).runs), [[BG, 'background']], 'a fresh check in the background is gone from Claude now');
    // busy stays busy, however long the turn (a review of a batch runs for an hour with no change of status)
    put('busy', old());
    await live.refreshLive(alive, look([]));
    assert.deepEqual(sessions((await now.nowRuns(alive)).runs), [[BG, 'busy']]);
  } finally { put('idle', Date.now()); await live.refreshLive(alive, look([])); }
});

test('the page: at work in the background is a badge of its own, waits for nobody, and the terminal\'s dot is still when Claude is', () => {
  const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  assert.match(read('js/board.js'), /\n  background: \['busy', 'working in the background', /, 'a card at work in the background has no badge');
  assert.match(read('js/board.js'), /l\.claude === 'idle' && l\.background/, 'a card waiting with commands in the background does not say so');
  const nowJs = read('js/now.js');
  assert.match(nowJs, /if \(run\.claude === 'background'\) return `<span class="card-live live-busy"/, 'a run at work in the background reads as one with no session');
  assert.match(nowJs, /else if \(run\.claude === 'background'\) parts\.push\(tr\('working in the background'\)\)/, 'the task a Claude in the background is on does not say so');
  assert.match(read('style.css'), /\.term-state\.live\.calm::after \{ display: none; \}/, 'the dot of a Claude that is not at work pulses');
  const dash = readFileSync(new URL('../src/routes/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /claude: currentLive\(\)\.filter\(\(x\) => !\['busy', 'starting', 'unsent'\]\.includes\(x\.claude\)(?: && x\.broke !== 'retrying')?\)/, 'Waiting for you lists a Claude at work on a turn');
});

// turn over: the owner's IS-25 asked for tokens and waited, the card said "working", nothing rang. The turn's end is the
// summary line right above the input box.
test('a turn over on the screen: busy in the registry is a Claude waiting at its prompt, and its task in work waits for you', async () => {
  const screen = (above) => [...above, '', `${'─'.repeat(38)} IS-25 ─`, '❯ ', '─'.repeat(45), '  ⬆ /gsd-update │ Opus 5.5 (1M context) │ …', '  ⏵⏵ auto mode on · 1 shell · ← for agents'].join('\n');
  assert.equal(phantom.turnOverOnScreen(screen(['  Paste the tokens and write "done".', '', '✻ Cooked for 2m 29s · done 2:43 PM'])), true);
  assert.equal(phantom.turnOverOnScreen(screen(['✻ Cooked for 2m 29s · done 2:43 PM · 1 shell', '  still running'])), true, 'a summary wrapped in a narrow window is not read');
  assert.equal(phantom.turnOverOnScreen(screen(['✻ Worked for 1h 2m 5s · done 12:43 PM'])), true);
  assert.equal(phantom.turnOverOnScreen(screen(['· Architecting… (6m 51s · ↓ 11.4k tokens)'])), false, 'the spinner of a turn reads as its end');
  assert.equal(phantom.turnOverOnScreen(screen(['✻ Baked for 5m 10s · done 5:32 PM', '', '❯ done, move it to Done'])), false, 'a new word of the person under the summary reads as the end of the turn');
  assert.equal(phantom.turnOverOnScreen(['✻ Baked for 5m 10s · done 5:32 PM', 'Enter to confirm · Esc to cancel'].join('\n')), false, 'a screen with no input box');
  const narrow = ['✻ Cooked for 2m 29s · done 2:43 PM', '', '─'.repeat(45), '❯ ', '─'.repeat(45), '  ⬆ /gsd-update │ Opus 5.5', '  (1M context) │ …', '  ⏵⏵ auto mode on · 2', '  shells · ← for agents', '  Context left until auto-compact: 9%'].join('\n');
  assert.equal(phantom.turnOverOnScreen(narrow), true, 'five status lines under the box hide the end of the turn');
  const move = (status) => app.inject({ method: 'PATCH', url: '/api/tasks/BG-2', headers: { 'x-claude-session': BUSY }, payload: { status } });
  assert.equal((await move('doing')).statusCode, 200);
  try {
    const look = (over) => async () => ({ live: [BUSY], questions: [], background: [], over, limited: [] });
    await live.refreshLive(alive, look([]));
    assert.equal(live.currentLive().find((t) => t.key === 'BG-2')?.claude, 'busy');
    await live.refreshLive(alive, look([BUSY]));
    const t = live.currentLive().find((x) => x.key === 'BG-2');
    assert.deepEqual([t?.claude, t?.background], ['idle', true], 'a Claude whose turn is over on the screen is said to work');
    assert.equal(t.since, null, 'a registry busy since the start of the turn dates the wait');
    assert.deepEqual(sessions((await now.nowRuns(alive)).runs).find((r) => r[0] === BUSY), [BUSY, 'idle'], 'Claude now says it works');
    assert.deepEqual(live.currentWorkProjects(), [], 'the sidebar lights green a project whose Claude waits for you');
    // next look rings "waiting for you" again
    await live.refreshLive(alive, look([]));
    assert.equal(live.currentLive().find((x) => x.key === 'BG-2')?.claude, 'idle', 'one look without the summary flips it back to busy');
    await live.refreshLive(alive, look([]));
    assert.equal(live.currentLive().find((x) => x.key === 'BG-2')?.claude, 'busy', 'a turn that started again is never seen');
  } finally {
    assert.equal((await move('review')).statusCode, 200);
    await live.refreshLive(alive, async () => ({ live: [], questions: [], background: [], over: [], limited: [] }));
  }
});
