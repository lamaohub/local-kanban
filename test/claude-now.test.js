// Claude that holds them (its session). A run says how much of it is handed in; a task says how far it is —
// by its checklist when it has one, by its stage otherwise. A run nobody leads any more (the session is
// gone, or no session and no movement for two hours) goes below the live ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const S1 = '11111111-1111-4111-8111-111111111111'; // a batch of four
const S2 = '22222222-2222-4222-8222-222222222222'; // a run whose Claude is gone
const S3 = '33333333-3333-4333-8333-333333333333'; // takes a task over later
const S4 = '44444444-4444-4444-8444-444444444444'; // its only task in work is on an archived board
let app, tmp, claude, db, now, bus;

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
  ({ bus } = await import('../src/bus.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','NW','Demo board',8)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('other','OT','Other board',3)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, archived) VALUES ('old','OL','Old board',2,1)").run();
  const pid = (slug) => db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
  for (const no of [1, 2, 3, 4, 5, 6, 7]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid('demo'), no, `Task ${no}`);
  for (const no of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid('other'), no, `Other ${no}`);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Archived','todo')").run(pid('old'));
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: sid ? { 'x-claude-session': sid } : {}, payload: { status } });
const reg = (file, data) => writeFileSync(join(claude, 'sessions', file), JSON.stringify(data));
const aliveOnly = (...pids) => (pid) => pids.includes(pid);
const runOf = (d, sid) => d.runs.find((r) => r.session === sid);
const rows = (run) => run.tasks.map((t) => [t.key, t.status, t.focus, t.percent]);

test('nothing in work: no runs', async () => {
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/now' })).json(), { runs: [], tasks_n: 0 });
});

test('a run lists its tasks top to bottom: handed in, the one Claude is on, then what waits its turn', async () => {
  for (const k of ['NW-1', 'NW-2', 'NW-3', 'NW-4']) await move(k, 'prep', S1); // a batch is moved to prep at once
  await move('NW-1', 'doing', S1);
  await move('NW-1', 'review', S1);
  await move('NW-2', 'doing', S1);
  reg('101.json', { pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  const d = await now.nowRuns(aliveOnly(101));
  assert.equal(d.runs.length, 1);
  const run = d.runs[0];
  assert.equal(run.session, S1);
  assert.equal(run.claude, 'busy');
  assert.equal(run.stale, false);
  assert.deepEqual(rows(run), [
    ['NW-1', 'review', false, 100],
    ['NW-2', 'doing', true, 50],
    ['NW-3', 'prep', false, 25],
    ['NW-4', 'prep', false, 25],
  ], 'the order is not handed in → the one Claude is on → the queue, or a stage gives another percent');
  assert.deepEqual([run.submitted_n, run.tasks_n, run.percent], [1, 4, 25], 'the run does not say "1 of 4 handed in"');
  assert.equal(d.tasks_n, 3, 'tasks_n counts the tasks in work, not the ones handed in');
});

test('a checklist says how far a task is better than its stage, and its ticks ring task.checklist', async () => {
  const heard = [];
  const on = (e) => { if (e.type === 'task.checklist') heard.push(e.data); };
  bus.on('event', on);
  const ids = [];
  for (const text of ['one', 'two', 'three', 'four']) {
    ids.push((await app.inject({ method: 'POST', url: '/api/tasks/NW-2/checklist', payload: { text } })).json().id);
  }
  const tick = (id, done) => app.inject({ method: 'PATCH', url: `/api/tasks/NW-2/checklist/${id}`, headers: { 'x-claude-session': S1 }, payload: { done } });
  await tick(ids[0], true);
  const pct = async () => runOf(await now.nowRuns(aliveOnly(101)), S1).tasks.find((t) => t.key === 'NW-2');
  assert.deepEqual([(await pct()).percent, (await pct()).checklist_n, (await pct()).checked_n], [25, 4, 1],
    'one of four items ticked: the stage (50%) was shown instead of the checklist');
  await tick(ids[1], true);
  assert.equal((await pct()).percent, 50);
  await app.inject({ method: 'PATCH', url: `/api/tasks/NW-2/checklist/${ids[2]}`, payload: { text: 'three, reworded' } });
  await tick(ids[1], true); // ticked already: nothing moved
  await app.inject({ method: 'DELETE', url: `/api/tasks/NW-2/checklist/${ids[3]}` });
  assert.equal((await pct()).percent, 67, 'two of three left');
  bus.off('event', on);
  assert.deepEqual(heard.map((e) => [e.key, e.project, e.checklist_n, e.checked_n, Boolean(e.text_only)]),
    [['NW-2', 'demo', 1, 0, false], ['NW-2', 'demo', 2, 0, false], ['NW-2', 'demo', 3, 0, false], ['NW-2', 'demo', 4, 0, false], ['NW-2', 'demo', 4, 1, false], ['NW-2', 'demo', 4, 2, false], ['NW-2', 'demo', 4, 2, true], ['NW-2', 'demo', 3, 2, false]],
    'an item added, ticked, reworded or removed must ring once; a tick that changes nothing must not');
  assert.deepEqual(heard.at(-2).checklist.map((c) => [c.text, c.done]), [['one', true], ['two', true], ['three, reworded', false], ['four', false]],
    'the event does not carry the list the open card draws');
});

test('an accepted task stays in its run as handed in; a cancelled one leaves it', async () => {
  await app.inject({ method: 'PATCH', url: '/api/tasks/NW-1', payload: { status: 'done' } }); // the person accepts
  await move('NW-4', 'cancelled', S1);
  const run = runOf(await now.nowRuns(aliveOnly(101)), S1);
  assert.deepEqual(run.tasks.map((t) => [t.key, t.status]), [['NW-1', 'done'], ['NW-2', 'doing'], ['NW-3', 'prep']],
    'accepting a task dropped it from its run, or a cancelled task still counts as work left');
  assert.deepEqual([run.submitted_n, run.tasks_n, run.percent], [1, 3, 33]);
});

test('a run of a Claude the board started in its own terminal says so — the view «Terminals» shows its screen (CK-652)', async () => {
  assert.equal(runOf(await now.nowRuns(aliveOnly(101)), S1).board, undefined, 'a session started elsewhere claimed a terminal of the board');
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(S1);
  try {
    assert.equal(runOf(await now.nowRuns(aliveOnly(101)), S1).board, true, 'a run of the board lost its terminal in «Terminals»');
  } finally {
    db.prepare('DELETE FROM board_sessions WHERE session_id = ?').run(S1);
  }
});

test('a closed session: its run goes below the live ones and shows where it stopped', async () => {
  // S2 takes NW-5 and NW-6 and switches to NW-6 before handing NW-5 in: both are in Doing, the focus is on NW-6
  for (const k of ['NW-5', 'NW-6']) await move(k, 'prep', S2);
  await move('NW-5', 'doing', S2);
  await move('NW-6', 'doing', S2);
  reg('202.json', { pid: 202, sessionId: S2, status: 'busy', statusUpdatedAt: 2000 });
  const d = await now.nowRuns(aliveOnly(101)); // 202 is not running any more
  assert.deepEqual(d.runs.map((r) => [r.session, r.claude, r.stale]), [[S1, 'busy', false], [S2, 'gone', true]],
    'a run nobody leads is listed among (or above) the live ones');
  assert.deepEqual(rows(runOf(d, S2)), [['NW-6', 'doing', true, 50], ['NW-5', 'doing', false, 50]],
    'the closed run no longer says where it stopped, or the task it stopped on is not above the rest of its stage');
});

// holds its tasks in work — the run stays among the live ones with its screen and «Continue», not folded away
test('a run of the board whose Claude has exited in its terminal stays in sight, with how it ended', async () => {
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(S2);
  try {
    const ended = await now.nowRuns(aliveOnly(101), async (sid) => (sid === S2 ? { dead: true, exit: 143, signal: null } : null));
    assert.equal(runOf(ended, S2).stale, false, 'the interrupted run went among the ones nobody leads');
    assert.deepEqual(runOf(ended, S2).ended, { exit: 143, interrupted: true });
    const own = await now.nowRuns(aliveOnly(101), async (sid) => (sid === S2 ? { dead: true, exit: 0, signal: null } : null));
    assert.deepEqual(runOf(own, S2).ended, { exit: 0, interrupted: false }, 'a Claude that ended itself read as interrupted');
    assert.equal(runOf(own, S2).stale, true, 'a Claude that ended itself stays among the live runs');
    const closed = await now.nowRuns(aliveOnly(101), async () => null);
    assert.equal(runOf(closed, S2).stale, true);
    assert.equal(runOf(closed, S2).ended, undefined);
  } finally {
    db.prepare('DELETE FROM board_sessions WHERE session_id = ?').run(S2);
  }
});

test('a task taken over by another session belongs to the newer run only', async () => {
  // the board keeps times to the second: S1 touched its tasks a minute ago, or the newer session could tie with it
  db.prepare("UPDATE task_sessions SET first_seen = datetime('now', '-1 minute'), last_seen = datetime('now', '-1 minute') WHERE session_id = ?").run(S1);
  await move('NW-3', 'doing', S3);
  reg('303.json', { pid: 303, sessionId: S3, status: 'waiting', statusUpdatedAt: 3000 });
  const d = await now.nowRuns(aliveOnly(101, 303));
  const keys = d.runs.flatMap((r) => r.tasks.map((t) => t.key));
  assert.equal(keys.filter((k) => k === 'NW-3').length, 1, 'a task taken over is listed in both runs');
  assert.deepEqual(rows(runOf(d, S3)), [['NW-3', 'doing', true, 50]]);
  assert.equal(runOf(d, S3).claude, 'waiting');
  assert.deepEqual(runOf(d, S1).tasks.map((t) => t.key), ['NW-1', 'NW-2']);
});

test('tasks in work that no session is tied to: grouped by project, two hours without a move puts them below', async () => {
  await move('OT-1', 'doing');
  await move('OT-2', 'doing');
  // an archived board is not shown at all — nor is a run whose only task in work is there: S4 handed NW-7 in
  // and works on OL-1, so nothing of S4 is in work on a board the person sees
  for (const st of ['prep', 'doing', 'review']) await move('NW-7', st, S4);
  await move('OL-1', 'doing', S4);
  db.prepare("UPDATE tasks SET updated_at = datetime('now', '-3 hours') WHERE title = 'Other 2'").run();
  const d = await now.nowRuns(aliveOnly(101, 303));
  const loose = d.runs.filter((r) => r.session === null);
  assert.deepEqual(loose.map((r) => [r.tasks.map((t) => t.key), r.stale, r.claude]), [[['OT-1'], false, null], [['OT-2'], true, null]]);
  assert.equal(loose[1].tasks[0].stale_h, 3);
  assert.equal(loose[0].tasks[0].stale_h, 0);
  assert.ok(!d.runs.some((r) => r.tasks.some((t) => t.key === 'OL-1')), 'a task of an archived board is shown');
  assert.ok(!runOf(d, S4), 'a run with nothing in work on a visible board is shown as an empty "handed in" run');
  // live runs first — newest on top — then the ones nobody leads, the most recently left on top
  assert.deepEqual(d.runs.map((r) => [r.session || r.tasks[0].project, r.stale]),
    [[S3, false], [S1, false], ['other', false], [S2, true], ['other', true]]);
});

test('the count of tasks in work is the one the sidebar sums from the project counters', async () => {
  reg('101.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 }); // a process that really runs
  const d = (await app.inject({ method: 'GET', url: '/api/now' })).json();
  const projects = (await app.inject({ method: 'GET', url: '/api/projects' })).json();
  const sidebar = projects.reduce((s, p) => s + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_deploy || 0), 0);
  assert.equal(d.tasks_n, sidebar, 'the section and its line in the sidebar would show different numbers');
  assert.equal(d.tasks_n, 6); // NW-2, NW-3, NW-5, NW-6, OT-1, OT-2
  assert.equal(runOf(d, S1).claude, 'busy');
});

test('a task by its stage when it has no checklist', () => {
  const p = (status, checklist_n = 0, checked_n = 0) => now.taskPercent({ status, checklist_n, checked_n });
  assert.deepEqual(['todo', 'prep', 'doing', 'deploy', 'review', 'done'].map((s) => p(s)), [0, 25, 50, 75, 100, 100]);
  assert.equal(p('doing', 3, 3), 100, 'a ticked-off checklist is the whole task, whatever the stage');
  assert.equal(p('review', 4, 1), 25, 'a task handed in with items left open must not claim 100%');
});

test('the page wires the section in: sidebar entry, its view, and the events that redraw it', () => {
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const sse = src('js/sse.js');
  assert.match(sse, /const SPECIAL_VIEWS = \[[^\]]*\bNOW\b/, 'a task event would patch a board that is not shown instead of re-reading the section');
  assert.match(sse, /if \(ev\.type === 'task\.checklist'\) \{ applyChecklist\(ev\.data\?\.key, ev\.data\?\.checklist\); if \(state\.slug === NOW && !ev\.data\?\.text_only\) loadTasks\(\)[^\n]*return; \}/,
    'task.checklist would fall into the queue and refresh the whole board on every tick');
  assert.match(sse, /\$\('now'\)\.classList\.toggle\('hidden', view !== 'now'\)/, 'showView does not show or hide the section');
  const sidebar = src('js/sidebar.js');
  assert.match(sidebar, /if \(state\.slug === NOW\) \{ showView\('now'\); await renderNow\(\); return; \}/);
  assert.match(sidebar, /const openable = \[[^\]]*\bNOW\b/, 'a tab left on the section would fall back to the first project on reload');
  assert.match(sidebar, /nowEl\.dataset\.slug = NOW;/, 'the sidebar entry is not reachable with [ and ]');
  assert.match(src('index.html'), /<div id="now" class="now-view hidden"><\/div>/);
  // every string the section shows goes through tr() and has a Russian line in the dictionary
  const core = src('js/core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const said = [...src('js/now.js').matchAll(/tr\('((?:[^'\\]|\\.)+)'\)/g)].map((m) => m[1]);
  assert.ok(said.length > 15, 'the section draws its words without tr()');
  const bare = (s) => new RegExp(`\\n\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: '`); // a key written without quotes
  const missing = said.filter((s) => !dict.includes(`'${s}':`) && !bare(s).test(dict));
  assert.deepEqual(missing, [], 'a string of the section stays English on the Russian board');
});
