// of the tasks in Review, as ▶ of that column does. One-shot; it runs on the server, so the page may be closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, folder, db, auto;
const hooks = { onMake: null }; // runs while a rule's check is being made — between its two requests

const WORDS = { title: 'Check the tasks in Review', tasks: 'Tasks in Review:', later: 'Later ones are not part of it.', done: 'kb done <KEY>.', report: 'Report on the card.', run: 'Run the kanban skill', doTask: 'Do the task' };
const inject = async (method, url, payload) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:3100' } });
const add = async (project, title, status = 'todo', labels = []) => (await inject('POST', '/api/tasks', { project, title, status, labels })).json();
const move = async (key, status) => {
  const r = await inject('PATCH', `/api/tasks/${key}`, { status });
  assert.ok(r.statusCode < 300, r.body);
};
const arm = (project, extra = {}) => inject('POST', '/api/automations', { project, words: WORDS, delay_min: 3, ...extra });
const rule = (id) => (db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
const view = async () => (await inject('GET', '/api/automations')).json();
const checks = (slug) => db.prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ? AND t.labels LIKE '%"check"%'`).all(slug);
let n = 0;
const project = (path = folder) => {
  n += 1;
  db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?, ?, ?, 1, ?)').run(`p${n}`, `P${n}X`, `Project ${n}`, path);
  return `p${n}`;
};
const MIN = 60_000;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-auto-')));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-test-auto-${process.pid}`; // never the board's own socket
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  auto = await import('../src/automations.js');
  app = Fastify();
  // the root guard of the live board (server.js): a rule's own requests have to pass it
  const { PORT } = await import('../src/config.js');
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  app.addHook('preHandler', async (req) => { if (req.method === 'POST' && req.url === '/api/tasks' && req.body?.labels?.includes('check')) hooks.onMake?.(); });
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/automations.js')).default);
  await app.ready();
  auto.setAutomationsOn(true);
  await (await import('../src/claude-live.js')).refreshLive(undefined, async () => ({ live: [], questions: [], background: [], over: [], limited: [] }));
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('a rule is refused at the door when its body is not one, and a project holds one waiting rule', async () => {
  const slug = project();
  assert.equal((await inject('POST', '/api/automations', { project: slug })).statusCode, 400, 'no words');
  assert.equal((await arm(slug, { delay_min: -1 })).statusCode, 400);
  assert.equal((await arm(slug, { delay_min: 1.5 })).statusCode, 400);
  assert.equal((await arm(slug, { delay_min: auto.DELAY_MAX_MIN + 1 })).statusCode, 400);
  assert.equal((await arm(slug, { words: { ...WORDS, run: '' } })).statusCode, 400);
  assert.equal((await arm('nope')).statusCode, 404);
  const first = await arm(slug);
  assert.equal(first.statusCode, 201, first.body);
  const second = await arm(slug);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().reason, 'armed');
  assert.equal(second.json().id, first.json().id);
});

test('set on a quiet project, a rule waits for work there — it does not check what was in Review already', async () => {
  const slug = project();
  const t = await add(slug, 'done before');
  await move(t.key, 'doing');
  await move(t.key, 'review');
  const id = (await arm(slug)).json().id;
  const t0 = Date.now();
  for (const at of [t0, t0 + 10 * MIN, t0 + 60 * MIN]) await auto.tickAutomations(app, at);
  assert.equal(rule(id).state, 'armed');
  assert.equal(checks(slug).length, 0, 'a check was made with no work since the rule was set');
  assert.equal((await view()).rules.find((r) => r.id === id).phase, 'idle');
});

test('Claude finishes the batch → the pause → one check of every task in Review, started inside the board, once', async () => {
  const slug = project();
  const a = await add(slug, 'one');
  const b = await add(slug, 'two');
  await move(a.key, 'doing');
  await move(b.key, 'prep');
  const id = (await arm(slug)).json().id; // set while Claude is at the batch — the owner's case
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  let r = (await view()).rules.find((x) => x.id === id);
  assert.equal(r.phase, 'working');
  assert.deepEqual(r.keys.sort(), [a.key, b.key].sort());
  await move(a.key, 'review');
  await auto.tickAutomations(app, t0 + 1000);
  assert.equal((await view()).rules.find((x) => x.id === id).phase, 'working', 'one task still in work holds it');
  await move(b.key, 'review');
  await auto.tickAutomations(app, t0 + 2000); // finished: the countdown starts here
  r = (await view()).rules.find((x) => x.id === id);
  assert.equal(r.phase, 'ready');
  assert.equal(r.due_at, t0 + 2000 + 3 * MIN);
  await auto.tickAutomations(app, t0 + 2000 + 3 * MIN - 1);
  assert.equal(checks(slug).length, 0, 'the check started before its pause was over');
  await auto.tickAutomations(app, t0 + 2000 + 3 * MIN);
  const made = checks(slug);
  assert.equal(made.length, 1);
  assert.match(made[0].description, new RegExp(`${a.key}, ${b.key}`), 'the check does not list the tasks in Review, oldest first');
  assert.equal(made[0].title, WORDS.title);
  assert.equal(rule(id).state, 'fired');
  r = (await view()).rules.find((x) => x.id === id);
  const prefix = db.prepare('SELECT prefix FROM projects WHERE slug = ?').get(slug).prefix;
  assert.equal(r.check_key, `${prefix}-${made[0].task_no}`);
  // one-shot: later looks make nothing more, even with new work done and finished
  const c = await add(slug, 'three');
  await move(c.key, 'doing');
  await auto.tickAutomations(app, t0 + 10 * MIN);
  await move(c.key, 'review');
  await auto.tickAutomations(app, t0 + 11 * MIN);
  await auto.tickAutomations(app, t0 + 20 * MIN);
  assert.equal(checks(slug).length, 1, 'a fired rule fired again');
});

test('what waits for the person holds it, and the pause starts anew after: a task handed back, the switch', async () => {
  const slug = project();
  const a = await add(slug, 'one');
  const b = await add(slug, 'two');
  await move(a.key, 'doing');
  await move(b.key, 'doing');
  const id = (await arm(slug)).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await move(a.key, 'review');
  await move(b.key, 'todo'); // Claude handed it back with questions
  await auto.tickAutomations(app, t0 + 1000);
  let r = (await view()).rules.find((x) => x.id === id);
  assert.equal(r.phase, 'held');
  assert.equal(r.reason, 'sent-back');
  assert.deepEqual(r.keys, [b.key]);
  await auto.tickAutomations(app, t0 + 30 * MIN);
  assert.equal(checks(slug).length, 0);
  // answered, taken again, finished
  await move(b.key, 'doing');
  await auto.tickAutomations(app, t0 + 31 * MIN);
  await move(b.key, 'review');
  // the switch off: nothing starts, and the pause begins again once it is on
  auto.setAutomationsOn(false);
  await auto.tickAutomations(app, t0 + 32 * MIN);
  r = (await view()).rules.find((x) => x.id === id);
  assert.equal(r.reason, 'off');
  await auto.tickAutomations(app, t0 + 40 * MIN);
  assert.equal(checks(slug).length, 0, 'started with the automations switched off');
  auto.setAutomationsOn(true);
  await auto.tickAutomations(app, t0 + 41 * MIN); // switched on again: the pause begins here
  assert.equal((await view()).rules.find((x) => x.id === id).phase, 'ready');
  await auto.tickAutomations(app, t0 + 44 * MIN - 1);
  assert.equal(checks(slug).length, 0, 'fired before the pause counted from the end of the hold');
  await auto.tickAutomations(app, t0 + 44 * MIN);
  assert.equal(rule(id).state, 'fired');
});

test('the judgement: a question on a screen, a request of Claude and a used-up subscription hold the check', () => {
  const tasks = [{ id: 1, key: 'X-1', status: 'review', labels: [], updated_at: '2026-01-01 00:00:00' }];
  const base = { tasks, back: [], check: null, live: {}, questions: new Set(), asks: new Set(), limited: false, now: Date.now() };
  assert.equal(auto.judge({ seen_work: 1 }, base).phase, 'ready');
  assert.equal(auto.judge({ seen_work: 0 }, base).phase, 'idle');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, questions: new Set([1]) }).reason, 'question');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, asks: new Set([1]) }).reason, 'ask');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, limited: true }).reason, 'limit');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, tasks: [] }).reason, 'nothing');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, check: 'X-9' }).reason, 'check-open', 'an open check (made before the rule) holds it');
  // a task in work whose Claude is gone holds nothing, as on ▶ of Review (holdsCheck)
  const gone = [...tasks, { id: 2, key: 'X-2', status: 'doing', labels: [], updated_at: '2026-01-01 00:00:00' }];
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, tasks: gone, live: { 2: { claude: 'gone' } } }).phase, 'ready');
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, tasks: gone, live: { 2: { claude: 'busy' } } }).phase, 'working');
});

test('a check that cannot start is told, the check stays in To do for ▶ on its card; a dropped rule goes to the history and out of it', async () => {
  // known at once: no folder, a permission or an effort the start would refuse
  const none = project(join(folder, 'no-such-folder'));
  const r0 = await arm(none);
  assert.equal(r0.statusCode, 409);
  assert.equal(r0.json().reason, 'no-folder');
  assert.equal((await arm(project(), { launch: { permission: 'bypassPermissions' } })).statusCode, 400);
  assert.equal((await arm(project(), { launch: { effort: 'huge' } })).statusCode, 400);
  // the folder goes away after the rule was set: the start refuses, the rule says why
  const gone = join(folder, `gone-${Date.now()}`);
  mkdirSync(gone);
  const slug = project(gone);
  const a = await add(slug, 'one');
  await move(a.key, 'doing');
  const id = (await arm(slug, { delay_min: 0 })).json().id;
  rmSync(gone, { recursive: true });
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await move(a.key, 'review');
  await auto.tickAutomations(app, t0 + 1000);
  await auto.tickAutomations(app, t0 + 2000);
  const r = rule(id);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /^no-folder:/);
  assert.equal(checks(slug).length, 1);
  assert.equal(checks(slug)[0].status, 'todo');

  const other = project();
  const drop = (await arm(other)).json().id;
  assert.equal((await inject('DELETE', `/api/automations/${drop}`)).statusCode, 200);
  assert.equal(rule(drop).state, 'cancelled');
  assert.ok((await view()).rules.some((x) => x.id === drop && x.state === 'cancelled'));
  assert.equal((await arm(other)).statusCode, 201, 'a cancelled rule still kept the project from a new one');
  assert.equal((await inject('DELETE', `/api/automations/${drop}`)).statusCode, 200);
  assert.equal(rule(drop), undefined);
  assert.equal((await inject('DELETE', `/api/automations/${drop}`)).statusCode, 404);
  assert.equal((await inject('DELETE', '/api/automations/x')).statusCode, 400);
});

test('the switch is the server\'s, and its answer carries the rules', async () => {
  assert.equal((await inject('PUT', '/api/automations/switch', { on: 'yes' })).statusCode, 400);
  const off = (await inject('PUT', '/api/automations/switch', { on: false })).json();
  assert.equal(off.on, false);
  assert.ok(Array.isArray(off.rules));
  assert.equal((await view()).on, false);
  assert.equal((await inject('PUT', '/api/automations/switch', { on: true })).json().on, true);
});

test('taken off while its check is being made, a rule stays taken off and Claude is not started', async () => {
  const slug = project();
  const a = await add(slug, 'one');
  await move(a.key, 'doing');
  const id = (await arm(slug, { delay_min: 0 })).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await move(a.key, 'review');
  await auto.tickAutomations(app, t0 + 1000);
  hooks.onMake = () => { db.prepare("UPDATE automations SET state = 'cancelled', ended_at = ? WHERE id = ?").run(Date.now(), id); };
  try { await auto.tickAutomations(app, t0 + 2000); } finally { hooks.onMake = null; }
  const r = rule(id);
  assert.equal(r.state, 'cancelled', 'a rule taken off was written down as fired');
  assert.ok(r.task_id, 'the history does not name the check that was made');
  assert.equal(checks(slug).length, 1);
});

test('a check started by hand after the rule was set ends the rule — it does not check again after that one', async () => {
  const slug = project();
  const a = await add(slug, 'one');
  await move(a.key, 'doing');
  const id = (await arm(slug)).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await move(a.key, 'review');
  await auto.tickAutomations(app, t0 + 1000); // the pause begins
  const byHand = await add(slug, 'check by hand', 'todo', ['check']);
  await auto.tickAutomations(app, t0 + 2000);
  const r = rule(id);
  assert.equal(r.state, 'covered');
  assert.equal((await view()).rules.find((x) => x.id === id).check_key, byHand.key);
  await move(byHand.key, 'cancelled');
  await auto.tickAutomations(app, t0 + 20 * MIN);
  assert.equal(checks(slug).length, 1, 'a second check was started after the one made by hand');
});

const CHECK_SID = 'dddddddd-9000-4000-8000-dddddddddddd';
/** The check's own Claude moves a task: its session is the check's, as `kb` tells it. */
const moveByCheck = async (slug, key, status) => {
  db.prepare("INSERT OR IGNORE INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(checks(slug)[0].id, CHECK_SID);
  return app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload: { status }, headers: { host: '127.0.0.1:3100', 'x-claude-session': CHECK_SID } });
};
const finishBatch = async (slug, at, keys = null) => {
  const list = keys || [await add(slug, `work ${at}`)];
  for (const x of list) await move(x.key, 'doing');
  await auto.tickAutomations(app, at);
  for (const x of list) await move(x.key, 'review');
  await auto.tickAutomations(app, at + 1000); // the pause starts
  return list;
};
const endCheck = (slug) => db.prepare(`UPDATE tasks SET status = 'done' WHERE project_id = (SELECT id FROM projects WHERE slug = ?) AND labels LIKE '%"check"%'`).run(slug);

test('CK-919: a repeating rule stays armed after its check and fires again on the next batch, not on what the check left', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 0 })).json().id;
  assert.equal((await view()).rules.find((x) => x.id === id).repeat, true);
  const t0 = Date.now();
  const first = await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  assert.equal(checks(slug).length, 1, 'the first check did not start');
  assert.equal(rule(id).state, 'armed', 'the rule went to the history');
  let r = (await view()).rules.find((x) => x.id === id);
  assert.equal(r.fires_n, 1);
  assert.ok(r.check_key, 'the rule does not say which check it started');
  // the check runs (its session alive), ends, and leaves a task in Review: no second check over it
  const made = checks(slug)[0];
  await auto.tickAutomations(app, t0 + 3000);
  endCheck(slug);
  for (let i = 0; i < 4; i++) await auto.tickAutomations(app, t0 + (4 + i) * MIN);
  assert.equal(checks(slug).length, 1, 'the rule went round on what its check left in Review');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(first[0].id).status, 'review');
  // the next batch
  const at = t0 + 10 * MIN;
  await finishBatch(slug, at);
  await auto.tickAutomations(app, at + 2000);
  assert.equal(checks(slug).length, 2, 'the next batch was not checked');
  assert.notEqual(rule(id).task_id, made.id);
  assert.equal((await view()).rules.find((x) => x.id === id).fires_n, 2);
  assert.match(checks(slug)[1].description, new RegExp(first[0].key), 'the second check does not take what still waits in Review');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-919: a check made by hand counts that batch for a repeating rule, and the rule stays', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 3 })).json().id;
  const t0 = Date.now();
  await finishBatch(slug, t0);
  await add(slug, 'by hand', 'todo', ['check']);
  await auto.tickAutomations(app, t0 + 2000);
  assert.equal(rule(id).state, 'armed');
  assert.equal(rule(id).seen_work, 0, 'the batch the hand check covers stays counted');
  endCheck(slug);
  await auto.tickAutomations(app, t0 + 20 * MIN);
  assert.equal(checks(slug).length, 1, 'a second check over the same batch');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-919: a task handed back counts from the rule\'s last check, not from when it was set', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 0 })).json().id;
  const t0 = Date.now();
  const back = await add(slug, 'handed back early');
  await move(back.key, 'doing');
  await move(back.key, 'todo'); // before the rule's first check
  await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  await auto.tickAutomations(app, t0 + 3000);
  db.prepare('UPDATE automations SET rearmed_at = ? WHERE id = ?').run(Date.now() + 1000, id);
  endCheck(slug);
  await finishBatch(slug, Date.now() + 2 * MIN);
  await auto.tickAutomations(app, Date.now() + 3 * MIN);
  assert.equal(rule(id).state, 'armed');
  assert.notEqual((await view()).rules.find((x) => x.id === id).reason, 'sent-back', 'an old hand-back holds every next check');
  await inject('DELETE', `/api/automations/${id}`);
});

// review: its own check, made within the second of the rule's re-arming, read as one made by hand
test('CK-919: a batch finished while the rule\'s own check runs is checked after it', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 0 })).json().id;
  const t0 = Date.now();
  await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  assert.equal(checks(slug).length, 1);
  const during = await finishBatch(slug, t0 + 3000);
  await auto.tickAutomations(app, t0 + 4000);
  assert.equal(rule(id).seen_work, 1, 'the batch finished under the check was dropped');
  assert.equal(checks(slug).length, 1, 'a second check beside the open one');
  endCheck(slug);
  await auto.tickAutomations(app, t0 + 5000);
  await auto.tickAutomations(app, t0 + 6000);
  assert.equal(checks(slug).length, 2, 'the batch was never checked');
  assert.match(checks(slug)[1].description, new RegExp(during[0].key));
  await inject('DELETE', `/api/automations/${id}`);
});

// review: one failed start stopped the person's automation for good, a line in the history the only word of it
test('CK-919: a repeating rule that could not start stays, says so, and a refused start takes no place', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 0 })).json().id;
  const t0 = Date.now();
  await finishBatch(slug, t0);
  db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run('/no/such/folder', slug);
  const other = project();
  const second = (await arm(other, { delay_min: 0 })).json().id;
  await finishBatch(other, t0 + 100);
  await auto.tickAutomations(app, t0 + 2000);
  const r = (await view()).rules.find((x) => x.id === id);
  assert.equal(rule(id).state, 'armed', 'a failed start took the rule off');
  assert.match(r.error, /no-folder|folder/);
  assert.equal(rule(second).state, 'fired', 'a start that failed took the place of the next rule');
  endCheck(slug);
  endCheck(other);
  db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run(folder, slug);
  await finishBatch(slug, t0 + 3000);
  await auto.tickAutomations(app, t0 + 5000);
  assert.equal(rule(id).error, null, 'the failure stayed after a good start');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-919: a rule has its checks of the day, and the board its checks at once', () => {
  const base = { tasks: [{ id: 1, key: 'K-1', status: 'review', labels: [], updated_at: '2026-10-31 10:00:00' }], back: [], check: null, live: {}, questions: new Set(), asks: new Set(), limited: false, now: Date.now() };
  assert.equal(auto.judge({ seen_work: 1 }, base).phase, 'ready');
  assert.deepEqual(auto.judge({ seen_work: 1 }, { ...base, dayFull: true }), { phase: 'held', reason: 'day-cap' });
  assert.deepEqual(auto.judge({ seen_work: 1 }, { ...base, busy: true }), { phase: 'held', reason: 'busy' });
  // what waits for the person is said first
  assert.equal(auto.judge({ seen_work: 1 }, { ...base, busy: true, back: ['K-2'] }).reason, 'sent-back');
});

test('CK-919: the day\'s limit stops a repeating rule, and a day later it goes on', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, delay_min: 0 })).json().id;
  const now = Date.now();
  db.prepare('UPDATE automations SET fires = ? WHERE id = ?').run(JSON.stringify(Array(auto.FIRES_DAY_MAX).fill(now - 3600000)), id);
  await finishBatch(slug, now);
  await auto.tickAutomations(app, now + 2000);
  assert.equal(checks(slug).length, 0, 'the rule fired past its limit of the day');
  assert.equal((await view()).rules.find((x) => x.id === id).reason, 'day-cap');
  await auto.tickAutomations(app, now + 24 * 60 * MIN);
  await auto.tickAutomations(app, now + 24 * 60 * MIN + 1000);
  assert.equal(checks(slug).length, 1, 'the rule did not go on the next day');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-919: no more than two checks run at once on the board; the third waits for a place', async () => {
  const slugs = [project(), project(), project()];
  const ids = [];
  const t0 = Date.now();
  for (const slug of slugs) {
    ids.push((await arm(slug, { delay_min: 0 })).json().id);
    await add(slug, 'in Review', 'todo').then(async (x) => { await move(x.key, 'doing'); await move(x.key, 'review'); });
  }
  // all three ready in the same look: the places are counted within it too
  db.prepare(`UPDATE automations SET seen_work = 1, ready_at = ? WHERE id IN (${ids.join(',')})`).run(t0 - 1000);
  await auto.tickAutomations(app, t0);
  assert.deepEqual(slugs.map((x) => checks(x).length), [1, 1, 0], 'three checks at once');
  // the two run: each holds its place
  for (const slug of slugs.slice(0, 2)) db.prepare(`UPDATE tasks SET status = 'doing', updated_at = datetime('now') WHERE project_id = (SELECT id FROM projects WHERE slug = ?) AND labels LIKE '%"check"%'`).run(slug);
  await auto.tickAutomations(app, Date.now());
  assert.equal((await view()).rules.find((x) => x.id === ids[2]).reason, 'busy');
  endCheck(slugs[0]);
  await auto.tickAutomations(app, Date.now());
  await auto.tickAutomations(app, Date.now() + 1000);
  assert.equal(checks(slugs[2]).length, 1, 'the third did not take the free place');
  for (const slug of slugs) endCheck(slug);
});

test('CK-919: repeat is a yes or a no at the door, and a rule without it is one-shot', async () => {
  assert.equal((await arm(project(), { repeat: 'yes' })).statusCode, 400);
  const id = (await arm(project())).json().id;
  assert.equal((await view()).rules.find((x) => x.id === id).repeat, false);
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-927: which sessions may go on, and how many times', async () => {
  const r = await import('../src/auto-resume.js');
  const run = (over) => ({ session: 's', claude: 'gone', tasks: [{ key: 'K-1', status: 'doing' }, { key: 'K-2', status: 'review' }], ...over });
  assert.deepEqual(r.resumable(run({})), ['K-1'], 'a session of the Terminal or the app is left behind');
  assert.deepEqual(r.resumable(run({ board: true, ended: { interrupted: true } })), ['K-1']);
  assert.deepEqual(r.resumable(run({ board: true, ended: { lost: true } })), ['K-1']);
  assert.equal(r.resumable(run({ board: true, ended: { exit: 0 } })), null, 'a Claude that exited by itself was brought back');
  assert.equal(r.resumable(run({ claude: 'idle' })), null, 'a Claude alive was started again');
  assert.equal(r.resumable(run({ session: null })), null);
  assert.equal(r.resumable(run({ tasks: [{ key: 'K-2', status: 'review' }] })), null, 'nothing in work');
  const now = 1e12;
  assert.equal(r.chainAllows(undefined, now), true);
  assert.equal(r.chainAllows({ n: 2, at: now }, now), true);
  assert.equal(r.chainAllows({ n: r.RESUME_TRIES, at: now }, now), false, 'more than three in a row');
  assert.equal(r.chainAllows({ n: r.RESUME_TRIES, at: now - 4 * 3600_000 }, now), true, 'a break hours later is a chain of its own');
  const step = (tool, extra = {}) => ({ kind: 'tool', tool, ...extra });
  assert.equal(r.howItStopped({ open: true, items: [step('Bash')] }, true), 'cut');
  assert.equal(r.howItStopped({ open: false, items: [step('Bash', { ms: 1 })] }, true), 'over');
  assert.equal(r.howItStopped({ open: true, items: [step('AskUserQuestion')] }, true), 'asks', 'a question to the person was gone past');
  assert.equal(r.howItStopped({ open: true, items: [step('Bash', { ms: 1 }), { kind: 'text', text: 'done' }] }, false), 'over', 'the app writes no end of a turn');
  assert.equal(r.howItStopped({ open: true, items: [{ kind: 'text', text: 'going on' }] }, true), 'cut');
  assert.equal(r.howItStopped(null, true), 'none');
});

test('CK-927: the switch, one session a look, a note in the card, and what waits for the person stays', async () => {
  const r = await import('../src/auto-resume.js');
  const slug = project();
  const a = await add(slug, 'cut');
  const b = await add(slug, 'waits');
  await move(a.key, 'doing');
  await move(b.key, 'doing');
  const sid = (n) => `cccccccc-${n}000-4000-8000-cccccccccccc`;
  for (const [t, s] of [[a, sid(1)], [b, sid(2)]]) db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(t.id, s);
  const runs = [{ session: sid(2), claude: 'gone', tasks: [{ key: b.key, status: 'doing' }] }, { session: sid(1), claude: 'gone', board: true, ended: { lost: true }, tasks: [{ key: a.key, status: 'doing' }] }];
  const told = [];
  r.setResumeDeps({ runs: async () => ({ runs }), turn: async () => ({ open: true, items: [{ kind: 'tool', tool: 'Bash' }] }), folder: async () => folder, fieldEmpty: async () => true, say: async (t, s, text) => { told.push([t.key, s, text]); } });
  r.resetResume();
  const notes = (x) => db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND author = 'board'").get(x.id).n;
  const look = (now, ctx) => r.tickResume(app, now, ctx);
  await look(1e12);
  assert.equal(notes(a) + notes(b), 0, 'it went on with the switch off');
  assert.equal(await inject('PUT', '/api/automations/extras', { resume: 'yes' }).then((x) => x.statusCode), 400);
  const v = (await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } })).json();
  assert.equal(v.extras.resume, true);
  await look(1e12, { waiting: new Set([b.id]) });
  assert.equal(notes(b), 0, 'a task that waits for the person was gone on with');
  assert.equal(notes(a), 0, 'the card says it went on before Claude was told a word');
  // `claude --resume` stands at its prompt: the board says the words once it is up, and only then it has gone on
  const held = { waiting: new Set([b.id]) };
  await look(1e12 + 2 * 60_000, held);
  assert.equal(told.length, 0, 'words typed into a Claude not up yet');
  runs[1] = { ...runs[1], claude: 'idle' };
  await look(1e12 + 4 * 60_000, held);
  assert.equal(told.length, 1, 'a Claude brought back was never told to go on');
  assert.equal(told[0][1], sid(1));
  assert.equal(notes(a), 1, 'the card does not say so');
  await look(1e12 + 4 * 60_000 + 1000, {});
  assert.equal(notes(b), 0, 'two looks within a minute');
  await look(1e12 + 6 * 60_000, { limited: true });
  assert.equal(notes(b), 0, 'it started at a used-up limit');
  // a session of the Terminal from another folder cannot be brought back from the project's
  r.setResumeDeps({ folder: async () => '/some/worktree' });
  told.length = 0;
  await look(1e12 + 8 * 60_000, {});
  runs[0] = { ...runs[0], claude: 'idle' };
  await look(1e12 + 10 * 60_000, {});
  assert.equal(told.length, 0, 'a session of another folder was brought back');
  r.setResumeDeps({ folder: async () => folder });
  runs[0] = { ...runs[0], claude: 'gone' };
  await look(1e12 + 12 * 60_000, {});
  runs[0] = { ...runs[0], claude: 'idle' };
  await look(1e12 + 14 * 60_000, {});
  assert.equal(notes(b), 1);
  // an open question: no Enter into it
  r.resetResume();
  told.length = 0;
  runs.length = 0;
  runs.push({ session: sid(4), claude: 'limit', board: true, tasks: [{ key: b.key, status: 'doing' }] });
  await look(3e12, { limited: true });
  runs[0] = { ...runs[0], claude: 'idle' };
  await look(3e12 + 2 * 60_000, { waiting: new Set([b.id]) });
  assert.equal(told.length, 0, 'the board typed over a question of Claude');
  // a Claude stopped at the limit, alive in its terminal: told once the limit has reset
  r.resetResume();
  runs.length = 0;
  runs.push({ session: sid(3), claude: 'limit', board: true, tasks: [{ key: a.key, status: 'doing' }] });
  await look(2e12, { limited: true });
  runs[0] = { ...runs[0], claude: 'idle' };
  await look(2e12 + 2 * 60_000, {});
  assert.equal(told.length, 1, 'a Claude stopped at the limit was not told to go on');
  assert.equal(told[0][0], a.key);
  const fake = (await inject('POST', '/api/launch', { mode: 'board', resume: sid(2), adopt: true, project: slug, keys: [b.key] })).statusCode;
  assert.equal(fake, 404, 'a request from outside brought back a session the board did not start');
  await inject('PUT', '/api/automations/extras', { resume: false });
  r.resetResume();
});

test('CK-934: a restart of the board loses no words, and a limit line that stays does not hold them for good', async () => {
  const r = await import('../src/auto-resume.js');
  const slug = project();
  const a = await add(slug, 'cut');
  await move(a.key, 'doing');
  const sid = 'cccccccc-9000-4000-8000-cccccccccccc';
  const told = [];
  const quiet = { turn: async () => ({ open: true, items: [] }), fieldEmpty: async () => true, say: async (t, s, text) => { told.push([t.key, s, text]); } };
  const runs = [{ session: sid, claude: 'limit', board: true, resets: '3pm', tasks: [{ key: a.key, status: 'doing' }] }];
  r.setResumeDeps({ ...quiet, runs: async () => ({ runs }) });
  r.resetResume();
  await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } });
  const stoppedAt = new Date(2026, 10, 2, 10, 0).getTime();
  await r.tickResume(app, stoppedAt, { limited: true });
  // the board restarts: a second copy of the module reads what the first one kept
  const again = await import('../src/auto-resume.js?restart=1');
  again.setResumeDeps({ ...quiet, runs: async () => ({ runs }) });
  await again.tickResume(app, stoppedAt + 2 * 3600_000, {});
  assert.equal(told.length, 0, 'told while the limit line stands and its moment has not come');
  await again.tickResume(app, new Date(2026, 10, 2, 15, 1).getTime(), {});
  assert.equal(told.length, 0, 'told within the grace after the moment');
  await again.tickResume(app, new Date(2026, 10, 2, 15, 3).getTime(), {});
  assert.equal(told.length, 1, 'the words are lost with the restart, or wait for a line that never goes');
  assert.equal(told[0][0], a.key);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'automations.resume.stopped'").get().value)[sid], undefined, 'said words stay kept');
  // the line stays after the words, and goes on naming the same moment: the chain of tries holds how many times
  const late = new Date(2026, 10, 2, 15, 3).getTime();
  for (let i = 1; i <= 8; i += 1) { await again.tickResume(app, late + i * 60_000, {}); await again.tickResume(app, late + i * 60_000 + 61_000, {}); }
  assert.ok(told.length <= 3, `told ${told.length} times over one line`);
  await inject('PUT', '/api/automations/extras', { resume: false });
  again.resetResume();
  r.resetResume();
});

/* What a look does with a kept record, by the board's own words. `resumeCase` brings a session back through the look itself,
   so the record is the one the board writes. */
const STOPPED = 'automations.resume.stopped';
const keptNow = () => JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(STOPPED)?.value || '{}');
const boardNotes = (id) => db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND author = 'board'").get(id).n;
// the notes are read in English: the board's language is set for the read, and the default (Russian) comes back after
const inEnglish = async (fn) => { db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('ui.lang', 'en')").run(); try { return await fn(); } finally { db.prepare("DELETE FROM kv WHERE key = 'ui.lang'").run(); } };
const lastNote = (id) => db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'board' ORDER BY id DESC LIMIT 1").get(id)?.body ?? '';
const statusOf = (key) => db.prepare("SELECT t.status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(key).status;
let resumeCases = 0;
async function resumeCase() {
  const r = await import('../src/auto-resume.js');
  const slug = project();
  const task = await add(slug, 'cut');
  await move(task.key, 'doing');
  resumeCases += 1;
  const sid = `dddddddd-${String(resumeCases).padStart(4, '0')}-4000-8000-dddddddddddd`;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(task.id, sid);
  const run = { session: sid, claude: 'gone', board: true, ended: { lost: true }, tasks: [{ key: task.key, status: 'doing' }] };
  const told = [];
  const deps = { runs: async () => ({ runs: [run] }), turn: async () => ({ open: true, items: [{ kind: 'tool', tool: 'Bash' }] }), folder: async () => folder,
    fieldEmpty: async () => true, say: async (t, s, text) => { told.push(text); } };
  // through `deps`, so a test changes one in the middle: the module keeps a copy of what it is given
  const relay = Object.fromEntries(Object.keys(deps).map((k) => [k, (...a) => deps[k](...a)]));
  r.setResumeDeps(relay);
  r.resetResume();
  await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } });
  return { r, slug, task, sid, run, told, deps, up: (m) => { m.setResumeDeps(relay); run.claude = 'idle'; } };
}
const resumeOff = async (...mods) => {
  await inject('PUT', '/api/automations/extras', { resume: false });
  for (const m of mods) m.resetResume();
};
const T0 = 7e12;

test('a restart right after `--resume` keeps the words: the record is written before the start', async () => {
  const c = await resumeCase();
  let again = null;
  const restarted = { inject: async () => { again = await import('../src/auto-resume.js?restart=start'); return { statusCode: 200 }; } };
  await c.r.tickResume(restarted, T0);
  assert.equal(keptNow()[c.sid]?.why, 'resume', 'the record is not in the database');
  c.up(again);
  await again.tickResume(app, T0 + 2 * MIN);
  assert.equal(c.told.length, 1, 'the words were lost with a restart right after the start');
  assert.equal(boardNotes(c.task.id), 1);
  await resumeOff(again, c.r);
});

test('a start refused or failed leaves no record behind', async () => {
  const c = await resumeCase();
  await c.r.tickResume({ inject: async () => ({ statusCode: 409, body: '{}' }) }, T0);
  assert.equal(keptNow()[c.sid], undefined, 'a refused start stayed kept');
  await c.r.tickResume({ inject: async () => { throw new Error('no answer'); } }, T0 + 2 * MIN);
  assert.equal(keptNow()[c.sid], undefined, 'a failed start stayed kept');
  c.run.claude = 'idle';
  await c.r.tickResume(app, T0 + 4 * MIN);
  assert.equal(c.told.length, 0, 'words went to a Claude the board never brought back');
  await resumeOff(c.r);
});

// The board's Stop is the person's word: to the automation a session stopped by it looked like one a restart cut, and the
// board brought back exactly the work the person had stopped. It waits for the person's own Continue.
test('a session the person stopped is not brought back by the board until the person continues it', async () => {
  const c = await resumeCase();
  let calls = 0;
  const counting = { inject: async (o) => { calls += 1; return app.inject(o); } };
  c.r.stoppedByPerson(c.sid, T0);
  for (let i = 0; i < 4; i += 1) await c.r.tickResume(counting, T0 + (i + 1) * MIN);
  assert.equal(calls, 0, 'the board brought back a session the person stopped');
  assert.equal(c.r.heldByPerson(c.sid, T0 + 5 * MIN), true);
  c.r.continuedByPerson(c.sid);
  await c.r.tickResume(counting, T0 + 6 * MIN);
  assert.equal(calls, 1, 'after the person\'s Continue the session is the automation\'s again');
  await resumeOff(c.r);
});

test('a start refused because tmux was slow takes no try, up to five of them; another refusal counts at once', async () => {
  const slow = await resumeCase();
  let calls = 0;
  const tmuxSlow = { inject: async () => { calls += 1; return { statusCode: 409, body: JSON.stringify({ error: 'tmux did not answer in time — try again', reason: 'tmux-slow' }) }; } };
  for (let i = 0; i < 12; i += 1) await slow.r.tickResume(tmuxSlow, T0 + i * MIN);
  assert.equal(calls, 8, 'five slow answers forgiven, then three tries — and no more');
  await resumeOff(slow.r);
  const other = await resumeCase();
  calls = 0;
  const refused = { inject: async () => { calls += 1; return { statusCode: 409, body: JSON.stringify({ error: 'no folder', reason: 'no-folder' }) }; } };
  for (let i = 0; i < 6; i += 1) await other.r.tickResume(refused, T0 + i * MIN);
  assert.equal(calls, 3, 'a refusal that is not tmux was forgiven');
  await resumeOff(other.r);
});

// go on with: the words refused by sayToTerminal leave no note and no error each minute, and «Continue» is not asked again
test('another board\'s Claude: the words refused as other-board go without a note, and its start is not asked again', async () => {
  const c = await resumeCase();
  Object.assign(c.run, { claude: 'limit', resets: '3pm', ended: undefined });
  const at = new Date(2026, 10, 2, 10, 0).getTime();
  await c.r.tickResume(app, at, { limited: true });
  c.deps.say = async () => ({ refused: 'other-board', port: 3100 });
  const errors = () => db.prepare("SELECT COUNT(*) AS n FROM app_errors WHERE message LIKE '%did not reach Claude%'").get().n;
  const was = errors();
  await c.r.tickResume(app, at + 6 * 3600_000);
  assert.equal(keptNow()[c.sid], undefined, 'the record of another board\'s Claude stayed');
  assert.equal(boardNotes(c.task.id), 0, 'a note said the board could not ask another board\'s Claude to go on');
  assert.equal(errors(), was, 'another board\'s terminal was logged as words that did not reach Claude');
  // tmux did not say whose the terminal is: nothing was typed — held as a silent tmux, no try spent, no error
  const slow = await resumeCase();
  Object.assign(slow.run, { claude: 'limit', resets: '3pm', ended: undefined });
  await slow.r.tickResume(app, at, { limited: true });
  slow.deps.say = async () => ({ refused: 'tmux-slow' });
  await slow.r.tickResume(app, at + 6 * 3600_000);
  assert.equal(keptNow()[slow.sid]?.held_by, 'tmux', 'a silent tmux was not held as one');
  assert.equal(keptNow()[slow.sid]?.failed, undefined, 'a silent tmux spent a try of the words');
  await resumeOff(slow.r);
  await resumeOff(c.r);
  const cut = await resumeCase();
  let calls = 0;
  const theirs = { inject: async () => { calls += 1; return { statusCode: 409, body: JSON.stringify({ error: 'this terminal was started by another board (port 3100)', reason: 'other-board', port: 3100 }) }; } };
  for (let i = 0; i < 6; i += 1) await cut.r.tickResume(theirs, T0 + i * MIN);
  assert.equal(calls, 1, 'the session of another board was asked to go on again and again');
  await resumeOff(cut.r);
});

test('a record given up on says what held the words', async () => {
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.run.claude = 'idle';
  c.deps.fieldEmpty = async () => null; // tmux does not answer
  await c.r.tickResume(app, T0 + 2 * MIN);
  assert.equal(keptNow()[c.sid]?.held_by, 'tmux', 'the record does not keep what held it');
  await inEnglish(() => c.r.tickResume(app, T0 + 11 * MIN));
  assert.equal(keptNow()[c.sid], undefined);
  assert.match(lastNote(c.task.id), /\(tmux did not answer\)$/);
  await resumeOff(c.r);
});

test('a limit record is in the database: the line gone after a restart, the words still go', async () => {
  const c = await resumeCase();
  Object.assign(c.run, { claude: 'limit', resets: '3pm', ended: undefined });
  const at = new Date(2026, 10, 2, 10, 0).getTime();
  await c.r.tickResume(app, at, { limited: true });
  assert.equal(keptNow()[c.sid]?.why, 'limit', 'the record of the limit is not in the database');
  const again = await import('../src/auto-resume.js?restart=limit');
  c.up(again);
  await again.tickResume(app, at + 6 * 3600_000);
  assert.equal(c.told.length, 1, 'the words were lost with the restart');
  await resumeOff(again, c.r);
});

test('a limit line first seen after its moment names that moment, in the look itself', async () => {
  const c = await resumeCase();
  Object.assign(c.run, { claude: 'limit', resets: '3pm', ended: undefined });
  const seen = new Date(2026, 10, 2, 15, 30).getTime();
  await c.r.tickResume(app, seen, { limited: true });
  await c.r.tickResume(app, seen + 2 * MIN);
  assert.equal(c.told.length, 1, 'a moment gone by was read as the same hour tomorrow');
  await resumeOff(c.r);
});

test('a limit line that names no moment holds the words', async () => {
  for (const resets of [undefined, 'soon']) {
    const c = await resumeCase();
    Object.assign(c.run, { claude: 'limit', resets, ended: undefined });
    await c.r.tickResume(app, T0, { limited: true });
    await c.r.tickResume(app, T0 + 24 * 3600_000);
    assert.equal(c.told.length, 0, `a line saying ${resets} was taken for a moment gone by`);
    assert.equal(keptNow()[c.sid]?.why, 'limit');
    await resumeOff(c.r);
  }
});

test('a person who took the session up meanwhile keeps it: no words, no record', async () => {
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.run.claude = 'idle';
  c.deps.turn = async () => ({ open: true, items: [{ kind: 'text', at: new Date(T0 + 1000).toISOString() }] });
  await c.r.tickResume(app, T0 + 2 * MIN);
  assert.equal(c.told.length, 0, 'the board typed after the person');
  assert.equal(keptNow()[c.sid], undefined, 'the record stayed');
  await resumeOff(c.r);
  const old = await resumeCase();
  await old.r.tickResume(app, T0);
  old.run.claude = 'idle';
  old.deps.turn = async () => ({ open: true, items: [{ kind: 'text', at: new Date(T0 - 1000).toISOString() }] });
  await old.r.tickResume(app, T0 + 2 * MIN);
  assert.equal(old.told.length, 1, 'a word from before the record held the board');
  await resumeOff(old.r);
});

test('a session gone from the runs is forgotten past its wait, not before', async () => {
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.deps.runs = async () => ({ runs: [] });
  await c.r.tickResume(app, T0 + 9 * MIN);
  assert.equal(keptNow()[c.sid]?.why, 'resume', 'forgotten inside its wait');
  await c.r.tickResume(app, T0 + 11 * MIN);
  assert.equal(keptNow()[c.sid], undefined, 'a session with nobody to tell stays kept for good');
  await resumeOff(c.r);
});

test('what is typed in the field is not sent with the words of the board: they wait, then go, or give up', async () => {
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.run.claude = 'idle';
  let field = false;
  c.deps.fieldEmpty = async () => field;
  await c.r.tickResume(app, T0 + 2 * MIN);
  assert.equal(c.told.length, 0, 'the words of the board went out with what is in the field');
  assert.equal(keptNow()[c.sid]?.why, 'resume', 'the record did not wait');
  field = null; // tmux did not answer
  await c.r.tickResume(app, T0 + 4 * MIN);
  assert.equal(c.told.length, 0, 'typed with the field unknown');
  field = true;
  await c.r.tickResume(app, T0 + 6 * MIN);
  assert.equal(c.told.length, 1, 'the words did not go once the field was empty');
  await resumeOff(c.r);
  // the words typed before a kill and never sent: they are in the field, the next board does not type them again
  const kept = await resumeCase();
  await kept.r.tickResume(app, T0);
  kept.run.claude = 'idle';
  kept.deps.fieldEmpty = async () => false;
  await kept.r.tickResume(app, T0 + 2 * MIN);
  await inEnglish(() => kept.r.tickResume(app, T0 + 11 * MIN));
  assert.equal(kept.told.length, 0);
  assert.equal(keptNow()[kept.sid], undefined, 'a field that stays full keeps the record past its wait');
  assert.match(lastNote(kept.task.id), /waits at its prompt\. \(something is typed in Claude's field\)$/, 'a record given up on over a full field said nothing of why');
  await resumeOff(kept.r);
});

test('a limit record, hours old by the reset, gets its full wait over a full field', async () => {
  const c = await resumeCase();
  Object.assign(c.run, { claude: 'limit', resets: '3pm', ended: undefined });
  const at = new Date(2026, 10, 2, 10, 0).getTime();
  await c.r.tickResume(app, at, { limited: true });
  c.run.claude = 'idle';
  c.deps.fieldEmpty = async () => false;
  const late = new Date(2026, 10, 2, 16, 0).getTime();
  await c.r.tickResume(app, late);
  assert.equal(keptNow()[c.sid]?.why, 'limit', 'the wait counted from the moment of the limit');
  await c.r.tickResume(app, late + 5 * MIN);
  assert.equal(keptNow()[c.sid]?.why, 'limit', 'gave up inside its wait');
  c.deps.fieldEmpty = async () => true;
  await c.r.tickResume(app, late + 7 * MIN);
  assert.equal(c.told.length, 1);
  await resumeOff(c.r);
  const full = await resumeCase();
  Object.assign(full.run, { claude: 'limit', resets: '3pm', ended: undefined });
  await full.r.tickResume(app, at, { limited: true });
  full.run.claude = 'idle';
  full.deps.fieldEmpty = async () => false;
  await full.r.tickResume(app, late);
  await inEnglish(() => full.r.tickResume(app, late + 11 * MIN));
  assert.equal(keptNow()[full.sid], undefined, 'a full field holds a limit record for good');
  assert.match(lastNote(full.task.id), /^The limit has reset, but .*\(something is typed in Claude's field\)$/, 'a limit record given up on over a full field said nothing');
  await resumeOff(full.r);
});

test('words of a resume are for the minutes after it, not for a day later', async () => {
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.run.claude = 'idle';
  await inEnglish(() => c.r.tickResume(app, T0 + 26 * 3600_000));
  assert.equal(c.told.length, 0, 'the words went 26 hours after the start');
  assert.equal(keptNow()[c.sid], undefined, 'the record stayed');
  assert.equal(boardNotes(c.task.id), 1, 'the record was given up on in silence');
  assert.match(lastNote(c.task.id), /could not tell Claude to go on/);
  await resumeOff(c.r);
});

test('a resume record past its wait over a Claude at work goes in silence; one at its prompt says it and is in the journal', async () => {
  const errs = () => db.prepare("SELECT message FROM app_errors WHERE message LIKE 'gave up telling %'").all().map((x) => x.message);
  for (const state of ['busy', 'waiting']) { // a gone one is brought back anew: a new record, not this one
    const c = await resumeCase();
    await c.r.tickResume(app, T0);
    c.run.claude = state;
    await c.r.tickResume(app, T0 + 2 * MIN);
    await inEnglish(() => c.r.tickResume(app, T0 + 11 * MIN));
    assert.equal(keptNow()[c.sid], undefined, `a record over a Claude ${state} stayed past its wait`);
    assert.equal(boardNotes(c.task.id), 0, `a Claude ${state} was said to wait at its prompt`);
    await resumeOff(c.r);
  }
  // at work at one look, at its prompt by the end of the wait: it waits there, and an old state is no reason
  const c = await resumeCase();
  await c.r.tickResume(app, T0);
  c.run.claude = 'busy';
  await c.r.tickResume(app, T0 + 2 * MIN);
  assert.equal(keptNow()[c.sid]?.held_by, 'state:busy');
  c.run.claude = 'idle';
  await inEnglish(() => c.r.tickResume(app, T0 + 11 * MIN));
  assert.equal(lastNote(c.task.id), 'The board brought the interrupted session back but could not tell Claude to go on: it waits at its prompt.');
  assert.ok(errs().some((m) => m.includes(`${c.task.key} to go on (resume): state:busy`)), 'the journal does not keep what held the words');
  await resumeOff(c.r);
});

test('words of the limit failing again and again are given up on, and the card says so', async () => {
  const c = await resumeCase();
  Object.assign(c.run, { claude: 'limit', resets: '3pm', ended: undefined });
  const at = new Date(2026, 10, 2, 10, 0).getTime();
  await c.r.tickResume(app, at, { limited: true });
  c.run.claude = 'idle';
  let tries = 0;
  c.deps.say = async () => { tries += 1; return { err: new Error('tmux') }; };
  const late = new Date(2026, 10, 2, 16, 0).getTime();
  await inEnglish(async () => { for (let i = 0; i < 6; i += 1) await c.r.tickResume(app, late + i * MIN); });
  assert.equal(tries, 3, 'the words were typed again every minute for good');
  assert.equal(keptNow()[c.sid], undefined);
  assert.equal(boardNotes(c.task.id), 1);
  assert.match(lastNote(c.task.id), /limit has reset, but the board could not/);
  assert.match(lastNote(c.task.id), /\(the words did not reach the terminal\)$/, 'a record given up on over failing words said nothing of why');
  await resumeOff(c.r);
});

test('a task that left work meanwhile is not moved back by the words', async () => {
  for (const status of ['review', 'ready', 'todo']) {
    const c = await resumeCase();
    await c.r.tickResume(app, T0);
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, c.task.id);
    c.run.claude = 'idle';
    await c.r.tickResume(app, T0 + 2 * MIN);
    assert.equal(c.told.length, 0, `words typed to a task in ${status}`);
    assert.equal(statusOf(c.task.key), status);
    assert.equal(keptNow()[c.sid], undefined);
    await resumeOff(c.r);
  }
});

test('words that did not reach Claude are no «went on»: the record stays, the card is silent', async () => {
  for (const answer of [{ err: new Error('tmux'), text: 'no pane' }, { refused: 'no-box' }]) {
    const c = await resumeCase();
    await c.r.tickResume(app, T0);
    c.run.claude = 'idle';
    let reply = answer;
    c.deps.say = async (t, s, text) => { if (reply) return reply; c.told.push(text); return { ok: true }; };
    await c.r.tickResume(app, T0 + 2 * MIN);
    assert.equal(boardNotes(c.task.id), 0, 'the card says the board went on, and nothing was said');
    assert.equal(keptNow()[c.sid]?.why, 'resume', 'the record was dropped with the words');
    reply = null;
    await c.r.tickResume(app, T0 + 4 * MIN);
    assert.equal(c.told.length, 1, 'the words were not tried again');
    assert.equal(boardNotes(c.task.id), 1);
    await resumeOff(c.r);
  }
});

test('CK-934: the moment a limit line names', async () => {
  const { resetAfter } = await import('../src/auto-resume.js');
  const since = new Date(2026, 10, 2, 22, 0).getTime();
  assert.equal(resetAfter('11:30pm', since), new Date(2026, 10, 2, 23, 30).getTime());
  assert.equal(resetAfter('12:50am', since), new Date(2026, 10, 3, 0, 50).getTime(), 'past today means tomorrow');
  assert.equal(resetAfter('3pm', since), new Date(2026, 10, 3, 15, 0).getTime());
  assert.equal(resetAfter('Nov 9 at 10am', since), new Date(2026, 10, 9, 10, 0).getTime());
  assert.equal(resetAfter('Nov 9, 10am', since), new Date(2026, 10, 9, 10, 0).getTime());
  assert.equal(resetAfter('Oct 9 at 10am', since), new Date(2027, 9, 9, 10, 0).getTime(), 'a date gone by means next year');
  assert.equal(resetAfter('9pm', since - 6 * 3600_000), new Date(2026, 10, 2, 21, 0).getTime(), 'first seen after its moment: that moment, not the same hour tomorrow');
  assert.equal(resetAfter(null, since), null);
  assert.equal(resetAfter('soon', since), null);
});

test('CK-928: fix is for a repeating rule, with the words of the return', async () => {
  assert.equal((await arm(project(), { fix: true })).statusCode, 400, 'fix without repeat');
  assert.equal((await arm(project(), { repeat: true, fix: 'y' })).statusCode, 400);
  assert.equal((await arm(project(), { repeat: true, fix: true })).statusCode, 400, 'fix without the words of the return');
  const id = (await arm(project(), { repeat: true, fix: true, words: { ...WORDS, back: 'Return it.' } })).json().id;
  assert.equal((await view()).rules.find((x) => x.id === id).fix, true);
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-928: what the check returned goes back to work, two rounds a task, and the card says so', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, fix: true, delay_min: 0, words: { ...WORDS, back: 'Return it.' } })).json().id;
  const t0 = Date.now() - 60_000; // the rule's check before the return, by the clock of the events
  const [task] = await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  assert.match(checks(slug)[0].description, /Return it\./, 'the check is not told how to return a task');
  const notes = () => db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'board' ORDER BY id").all(task.id).map((x) => x.body);
  const returned = async (at) => {
    await moveByCheck(slug, task.key, 'todo');
    await auto.tickAutomations(app, at);
  };
  // the check still open: nothing goes
  await returned(t0 + 3000);
  assert.equal(notes().length, 0, 'a fix started beside the open check');
  endCheck(slug);
  await auto.tickAutomations(app, Date.now());
  assert.equal(notes().length, 1, 'the returned task did not go back to work');
  assert.match(notes()[0], / 1 \S+ 2\)/, 'the card does not say the round');
  await auto.tickAutomations(app, Date.now() + 500);
  assert.equal(notes().length, 1, 'the same return was started twice');
  // second round
  await new Promise((r) => { setTimeout(r, 1100); });
  await move(task.key, 'doing'); await move(task.key, 'review');
  await new Promise((r) => { setTimeout(r, 1100); });
  await returned(Date.now() + 1000);
  assert.equal(notes().length, 2);
  assert.match(notes()[1], / 2 \S+ 2\)/);
  // third return: it waits for the person, and says so once
  await new Promise((r) => { setTimeout(r, 1100); });
  await move(task.key, 'doing'); await move(task.key, 'review');
  await new Promise((r) => { setTimeout(r, 1100); });
  await returned(Date.now() + 2000);
  assert.equal(notes().length, 3);
  assert.doesNotMatch(notes()[2], / \d \S+ \d\)/, 'a third round started');
  await auto.tickAutomations(app, Date.now() + 3000);
  assert.equal(notes().length, 3, 'the end of the rounds was said twice');
  assert.equal(rule(id).state, 'armed');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-928: a task marked ask, done by hand or moved back by the person stays the person\'s', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, fix: true, delay_min: 0, words: { ...WORDS, back: 'Return it.' } })).json().id;
  const t0 = Date.now() - 60_000;
  const [task] = await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  const of = () => auto.returnedTasks(rule(id).project_id, Date.now() - 60_000, rule(id).task_id).map((x) => x.key);
  await move(task.key, 'todo');
  assert.deepEqual(of(), [], 'the person moved it back, and the board took it for the check\'s return');
  await move(task.key, 'doing'); await move(task.key, 'review');
  await inject('PATCH', `/api/tasks/${task.key}`, { labels_add: ['ask'] });
  await moveByCheck(slug, task.key, 'todo');
  assert.deepEqual(of(), [], 'an ask task was taken');
  await inject('PATCH', `/api/tasks/${task.key}`, { labels_remove: ['ask'] });
  assert.deepEqual(of(), [task.key]);
  endCheck(slug);
  await inject('DELETE', `/api/automations/${id}`);
});

// review: a refused start spent a round, and the task stood in To do with no word
test('CK-928: a start refused spends no round and is tried again', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, fix: true, delay_min: 0, words: { ...WORDS, back: 'Return it.' } })).json().id;
  const t0 = Date.now() - 60_000;
  const [task] = await finishBatch(slug, t0);
  await auto.tickAutomations(app, t0 + 2000);
  await moveByCheck(slug, task.key, 'todo');
  endCheck(slug);
  db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run('/no/such/folder', slug);
  await auto.tickAutomations(app, Date.now());
  assert.equal(rule(id).rounds, '{}', 'a start that did not happen spent a round');
  assert.match(rule(id).error, /folder/);
  db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run(folder, slug);
  await auto.tickAutomations(app, Date.now() + 60_000);
  assert.equal(rule(id).rounds, '{}', 'tried again at once, every look');
  const restarted = await import('../src/automations.js?restart=ck948');
  await restarted.tickAutomations(app, Date.now() + 90_000);
  assert.equal(rule(id).rounds, '{}', 'a restart in the pause tried at once, sooner than the page said');
  await auto.tickAutomations(app, Date.now() + 6 * 60_000);
  assert.equal(JSON.parse(rule(id).rounds)[task.id].n, 1, 'never tried again');
  assert.equal(rule(id).error, null);
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-929: which tasks a queue takes, and what holds it', () => {
  const t = (key, over = {}) => ({ id: Number(key.slice(2)), key, status: 'todo', labels: [], ...over });
  const list = [t('K-1'), t('K-2', { priority: 3 }), t('K-3', { labels: ['ask'] }), t('K-4', { labels: ['noclaude'] }), t('K-5', { blocked: 1 }), t('K-6', { labels: ['check'] }),
    t('K-7', { status: 'backlog' }), t('K-8', { pinned: 1 }), t('K-9'), t('K-10'), t('K-11'), t('K-12')];
  assert.deepEqual(auto.queueBatch(list), ['K-8', 'K-2', 'K-1', 'K-9', 'K-10'], 'pinned, then priority, at most five, no ask, no noclaude, no blocked, no check');
  assert.deepEqual(auto.queueBatch(list, new Set([8, 2])), ['K-1', 'K-9', 'K-10', 'K-11', 'K-12'], 'a task a fix rule gave up on was taken');
  const base = { tasks: [], back: [], check: null, live: {}, questions: new Set(), asks: new Set(), limited: false, now: Date.now(), batch: ['K-1'] };
  assert.deepEqual(auto.queueJudge(base), { phase: 'ready', keys: ['K-1'] });
  assert.equal(auto.queueJudge({ ...base, over: true }).reason, 'limit-high');
  assert.equal(auto.queueJudge({ ...base, limited: true }).reason, 'limit-high');
  assert.equal(auto.queueJudge({ ...base, check: 'K-9' }).reason, 'check-open');
  assert.equal(auto.queueJudge({ ...base, back: ['K-2'] }).reason, 'sent-back');
  assert.equal(auto.queueJudge({ ...base, batch: [] }).reason, 'queue-empty');
  const old = { id: 2, key: 'K-2', status: 'doing', labels: [], updated_at: '2020-01-01 00:00:00' };
  assert.deepEqual(auto.queueJudge({ ...base, tasks: [old], live: { 2: { claude: 'gone' } } }), { phase: 'held', reason: 'unfinished', keys: ['K-2'] }, 'a batch over work cut off');
  assert.equal(auto.queueJudge({ ...base, tasks: [{ ...old, labels: ['noclaude'] }] }).phase, 'ready', 'a manual task in work holds the queue');
  assert.equal(auto.queueJudge({ ...base, dayFull: true }).reason, 'day-cap');
  assert.equal(auto.queueJudge({ ...base, tasks: [{ id: 1, key: 'K-1', status: 'doing', labels: [], updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }] }).phase, 'working');
});

test('CK-929: a queue starts the batch after its pause, a project has one of a kind beside its check rule', async () => {
  const slug = project();
  const queue = { kind: 'todo-queue', delay_min: 1, words: { run: 'Run the skill', doTask: 'Do the tasks' } };
  const id = (await arm(slug, queue)).json().id;
  assert.equal((await arm(slug, queue)).statusCode, 409, 'two queues on a project');
  assert.equal((await arm(slug)).statusCode, 201, 'a queue took the place of the check rule');
  assert.equal(rule(id).repeat, 1, 'a queue stays');
  const t = await add(slug, 'next');
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  assert.equal((await view()).rules.find((x) => x.id === id).phase, 'ready');
  await auto.tickAutomations(app, t0 + 30_000);
  assert.equal(JSON.parse(rule(id).fires).length, 0, 'it started before its pause was over');
  await auto.tickAutomations(app, t0 + 61_000);
  assert.equal(JSON.parse(rule(id).fires).length, 1, 'the batch did not start');
  assert.equal(rule(id).state, 'armed');
  assert.ok(t.key);
  for (const r of (await view()).rules.filter((x) => x.project === slug && x.state === 'armed')) await inject('DELETE', `/api/automations/${r.id}`);
});

test('CK-929: a schedule runs at its time, once, and a run the sleeping Mac missed is skipped', async () => {
  const at = new Date(2026, 9, 31, 3, 0).getTime(); // a Saturday
  const plan = { at: '03:00', day: null };
  assert.equal(auto.slotOf(plan, at - 1000), null, 'before its time');
  assert.equal(auto.slotOf(plan, at), at);
  assert.equal(auto.slotOf(plan, at + 9 * 60_000), at);
  assert.equal(auto.slotOf(plan, at + auto.SLOT_WINDOW_MS), null, 'a missed run was started late');
  assert.equal(auto.slotOf({ at: '03:00', day: 6 }, at), at);
  assert.equal(auto.slotOf({ at: '03:00', day: 1 }, at), null, 'another day of the week');
  const slug = project();
  assert.equal((await arm(slug, { kind: 'schedule-check' })).statusCode, 400, 'a schedule without its time');
  assert.equal((await arm(slug, { kind: 'schedule-check', plan: { at: '25:00' } })).statusCode, 400);
  assert.equal((await arm(slug, { kind: 'schedule-check', plan: { at: '03:00', day: 9 } })).statusCode, 400);
  const id = (await arm(slug, { kind: 'schedule-check', plan })).json().id;
  await add(slug, 'in Review').then(async (x) => { await move(x.key, 'doing'); await move(x.key, 'review'); });
  db.prepare("UPDATE tasks SET updated_at = datetime('now', '-1 day') WHERE project_id = ?").run(rule(id).project_id);
  await auto.tickAutomations(app, at - 60_000);
  assert.equal(checks(slug).length, 0, 'it ran before its time');
  assert.equal((await view()).rules.find((x) => x.id === id).phase, 'planned');
  await auto.tickAutomations(app, at + 20 * 60_000);
  assert.equal(checks(slug).length, 0, 'a run the sleeping Mac missed was started');
  await auto.tickAutomations(app, at + 1000);
  assert.equal(checks(slug).length, 1, 'the run did not start at its time');
  endCheck(slug);
  await auto.tickAutomations(app, at + 2000);
  assert.equal(checks(slug).length, 1, 'the same run went twice');
  await auto.tickAutomations(app, at + 24 * 3600_000 + 1000);
  assert.equal(checks(slug).length, 2, 'the next night did not run');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-929: the grooming of the backlog moves no task', async () => {
  const at = new Date(2026, 9, 31, 3, 0).getTime();
  const slug = project();
  const id = (await arm(slug, { kind: 'schedule-groom', plan: { at: '03:00', day: 6 }, words: { run: 'Run the skill', groom: `Groom the backlog of ${slug} (grooming mode):` } })).json().id;
  const b = await add(slug, 'an idea', 'backlog');
  await auto.tickAutomations(app, at + 1000);
  assert.equal(JSON.parse(rule(id).fires).length, 1, 'the grooming did not start');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(b.id).status, 'backlog', 'a task moved');
  await inject('DELETE', `/api/automations/${id}`);
});

test('CK-930: the summary tells what moved since the moment asked, without manual tasks and checks', async () => {
  const slug = project();
  const handed = await add(slug, 'handed');
  const accepted = await add(slug, 'accepted');
  const back = await add(slug, 'back');
  const stuck = await add(slug, 'stuck');
  const manual = await add(slug, 'by hand', 'todo', ['noclaude']);
  const check = await add(slug, 'a check', 'todo', ['check']);
  const since = Date.now() - 2000;
  for (const x of [handed, accepted, back, stuck]) await move(x.key, 'doing');
  const old = await add(slug, 'died long ago');
  await move(old.key, 'doing');
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, 'a', datetime('now'), datetime('now'))").run(stuck.id);
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, 'b', '2020-01-01 00:00:00', '2020-01-01 00:00:00')").run(old.id);
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, 'c', datetime('now'), datetime('now'))").run(check.id);
  await move(handed.key, 'review');
  await move(accepted.key, 'review');
  await inject('PATCH', `/api/tasks/${accepted.key}`, { status: 'done' });
  await move(back.key, 'review');
  await move(back.key, 'todo');
  await move(manual.key, 'doing'); await move(manual.key, 'review');
  await move(check.key, 'doing'); await move(check.key, 'review');
  const s = await auto.awaySummary(since, [{ session: 's', claude: 'gone', tasks: [{ key: stuck.key, status: 'doing' }, { key: old.key, status: 'doing' }, { key: check.key, status: 'doing' }, { key: handed.key, status: 'review' }] }, { session: 't', claude: 'idle', tasks: [{ key: back.key, status: 'doing' }] }]);
  const prefix = handed.key.split('-')[0];
  const keys = (x) => x.tasks.map((t) => t.key).filter((k) => k.startsWith(`${prefix}-`)).sort();
  assert.deepEqual(keys(s.handed), [handed.key], 'handed in');
  assert.deepEqual(keys(s.accepted), [accepted.key], 'accepted');
  assert.deepEqual(keys(s.returned), [back.key], 'returned');
  assert.deepEqual(keys(s.stuck), [stuck.key], 'stuck');
  assert.equal(s.stuck.tasks[0].title, 'stuck');
  const later = await auto.awaySummary(Date.now() + 60_000, []);
  assert.equal(keys(later.handed).length + keys(later.accepted).length + keys(later.returned).length, 0, 'moves before the moment asked are told');
  assert.equal((await inject('GET', '/api/automations/summary')).statusCode, 400);
  assert.equal((await inject('GET', '/api/automations/summary?since=x')).statusCode, 400);
  assert.equal((await inject('GET', `/api/automations/summary?since=${since}`)).statusCode, 200);
});

test('CK-931: a CLAUDE.md past the norm gets a task in the backlog, once, and is not started', async () => {
  const h = await import('../src/auto-health.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kb-heavy-')));
  const small = realpathSync(mkdtempSync(join(tmpdir(), 'kb-small-')));
  writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(40_001));
  writeFileSync(join(small, 'CLAUDE.md'), 'x'.repeat(40_000));
  const heavy = project(dir);
  const fine = project(small);
  const tasks = (slug) => db.prepare('SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ?').all(slug);
  let at = Date.now() + 1000;
  await auto.tickAutomations(app, at);
  assert.equal(tasks(heavy).length, 0, 'it looked with the switch off');
  assert.equal((await inject('PUT', '/api/automations/extras', { health: 'yes' })).statusCode, 400);
  const v = (await inject('PUT', '/api/automations/extras', { health: true })).json();
  assert.equal(v.extras.health, true);
  await auto.tickAutomations(app, at);
  const made = tasks(heavy);
  assert.equal(made.length, 1, 'the heavy file got no task');
  assert.equal(made[0].status, 'backlog', 'the task was started, or not in the backlog');
  assert.match(made[0].description, /CLAUDE\.md/);
  assert.equal(tasks(fine).length, 0, 'a file at the norm got a task');
  at += h.HEALTH_EVERY_MS + 1000;
  await auto.tickAutomations(app, at);
  assert.equal(tasks(heavy).length, 1, 'a second task beside the open one');
  // the person cancelled it: not opened again; done with the file still heavy: opened again
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(made[0].id);
  at += h.HEALTH_EVERY_MS + 1000;
  await auto.tickAutomations(app, at);
  assert.equal(tasks(heavy).length, 1, 'a task the person cancelled came back');
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(made[0].id);
  at += h.HEALTH_EVERY_MS + 1000;
  await auto.tickAutomations(app, at);
  assert.equal(tasks(heavy).length, 2, 'the file is still heavy after a task done');
  await inject('PUT', '/api/automations/extras', { health: false });
  for (const d of [dir, small]) rmSync(d, { recursive: true, force: true });
});

test('a project archived under a waiting rule takes the rule off; with nothing waiting a look does nothing', async () => {
  const slug = project();
  const id = (await arm(slug)).json().id;
  db.prepare('UPDATE projects SET archived = 1 WHERE slug = ?').run(slug);
  await auto.tickAutomations(app, Date.now());
  assert.equal(rule(id).state, 'cancelled');
  assert.match(rule(id).error, /^archived:/);
  assert.ok(!(await view()).rules.some((x) => x.id === id && x.state === 'armed'), 'the sidebar would count it as waiting');
});
