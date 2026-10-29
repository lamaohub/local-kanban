// of the tasks in Review, as ▶ of that column does. One-shot; it runs on the server, so the page may be closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
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

test('a project archived under a waiting rule takes the rule off; with nothing waiting a look does nothing', async () => {
  const slug = project();
  const id = (await arm(slug)).json().id;
  db.prepare('UPDATE projects SET archived = 1 WHERE slug = ?').run(slug);
  await auto.tickAutomations(app, Date.now());
  assert.equal(rule(id).state, 'cancelled');
  assert.match(rule(id).error, /^archived:/);
  assert.ok(!(await view()).rules.some((x) => x.id === id && x.state === 'armed'), 'the sidebar would count it as waiting');
});
