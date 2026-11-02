import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, folder, db, auto, kvSet;
const hooks = { onLaunch: null, launches: [] };
const WORDS = { title: 'Check the tasks in Review', tasks: 'Tasks in Review:', later: 'Later ones are not part of it.', done: 'kb done <KEY>.', report: 'Report on the card.', run: 'Run the kanban skill', doTask: 'Do the task' };
const inject = async (method, url, payload) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:3100' } });
const add = async (project, title, status = 'todo', labels = []) => (await inject('POST', '/api/tasks', { project, title, status, labels })).json();
const move = async (key, status) => { const r = await inject('PATCH', `/api/tasks/${key}`, { status }); assert.ok(r.statusCode < 300, r.body); };
const arm = (project, extra = {}) => inject('POST', '/api/automations', { project, words: WORDS, delay_min: 0, ...extra });
const rule = (id) => db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
const checks = (slug) => db.prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ? AND t.labels LIKE '%"check"%'`).all(slug);
const dropAll = async (slug) => { for (const r of (await inject('GET', '/api/automations')).json().rules.filter((x) => x.project === slug && x.state === 'armed')) await inject('DELETE', `/api/automations/${r.id}`); };
let n = 0;
const project = (path = folder) => {
  n += 1;
  db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?, ?, ?, 1, ?)').run(`q${n}`, `Q${n}X`, `Project ${n}`, path);
  return `q${n}`;
};
const QUEUE = { kind: 'todo-queue', words: { run: 'Run the skill', doTask: 'Do the tasks' } };
const limits = (used) => kvSet('claude.limits', JSON.stringify({ windows: { five_hour: { used, resets_at: Math.round(Date.now() / 1000) + 7200 } }, at: new Date().toISOString() }));
const CHECK_SID = 'dddddddd-9000-4000-8000-dddddddddddd';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-accept-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-accept-f-')));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-accept-${process.pid}`;
  ({ db, kvSet } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  auto = await import('../src/automations.js');
  app = Fastify();
  const { PORT } = await import('../src/config.js');
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  app.addHook('preHandler', async (req) => { if (req.method === 'POST' && req.url === '/api/launch') { hooks.launches.push(req.body); hooks.onLaunch?.(req.body); } });
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

test('«Take off» pressed during the start of Claude stays taken off', async () => {
  const slug = project();
  const t = await add(slug, 'one');
  await move(t.key, 'doing');
  const id = (await arm(slug)).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await move(t.key, 'review');
  await auto.tickAutomations(app, t0 + 1000);
  hooks.onLaunch = () => { auto.dropRule(id, Date.now()); };
  await auto.tickAutomations(app, t0 + 2000);
  hooks.onLaunch = null;
  assert.equal(rule(id).state, 'cancelled', 'the rule said «started» after it was taken off');
});

test('own check made within the second of the re-arming, by the real clock: the batch under it is not dropped', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true })).json().id;
  const t = await add(slug, 'first');
  await move(t.key, 'doing');
  await auto.tickAutomations(app, Date.now());
  await move(t.key, 'review');
  await auto.tickAutomations(app, Date.now());
  await auto.tickAutomations(app, Date.now()); // fires now: rearmed_at is this very moment
  assert.equal(checks(slug).length, 1);
  const next = await add(slug, 'second');
  await move(next.key, 'doing');
  await auto.tickAutomations(app, Date.now());
  await move(next.key, 'review');
  await auto.tickAutomations(app, Date.now());
  assert.equal(rule(id).seen_work, 1, 'the batch finished under the rule\'s own check was dropped');
  await dropAll(slug);
});

test('resume looks at how the turn stopped through the look itself: an ended turn or a question is left alone', async () => {
  const r = await import('../src/auto-resume.js');
  const slug = project();
  const t = await add(slug, 'cut');
  await move(t.key, 'doing');
  const sid = 'eeeeeeee-1000-4000-8000-eeeeeeeeeeee';
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(t.id, sid);
  const runs = [{ session: sid, claude: 'gone', tasks: [{ key: t.key, status: 'doing' }] }];
  await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } });
  for (const [i, turn] of [{ open: false, items: [{ kind: 'text', text: 'done', at: '2026-10-31T10:00:00Z' }] }, { open: true, items: [{ kind: 'tool', tool: 'AskUserQuestion' }] }, null].entries()) {
    r.resetResume();
    hooks.launches.length = 0;
    r.setResumeDeps({ runs: async () => ({ runs }), turn: async () => turn, folder: async () => folder });
    await r.tickResume(app, 5e12 + i * 120_000, {});
    assert.equal(hooks.launches.length, 0, `a session was brought back with the turn ${JSON.stringify(turn)}`);
  }
  await inject('PUT', '/api/automations/extras', { resume: false });
});

test('the master switch off stops resume and health too, not only the rules', async () => {
  const r = await import('../src/auto-resume.js');
  let looked = 0;
  r.setResumeDeps({ runs: async () => { looked += 1; return { runs: [] }; } });
  r.resetResume();
  await (await import('../src/claude-live.js')).refreshLive(undefined, async () => ({ live: [], questions: [] })); // a first look is over: only the switch holds it
  await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } });
  auto.setAutomationsOn(false);
  await auto.tickAutomations(app, Date.now() + 1e9);
  assert.equal(looked, 0, 'the board went on with work while the automations were off');
  auto.setAutomationsOn(true);
  await auto.tickAutomations(app, Date.now() + 2e9);
  assert.equal(looked, 1, 'the look never went: the switch above proves nothing');
  await inject('PUT', '/api/automations/extras', { resume: false });
});

test('a fix waits for a used-up limit', async () => {
  const slug = project();
  const id = (await arm(slug, { repeat: true, fix: true, words: { ...WORDS, back: 'Return it.' } })).json().id;
  const t0 = Date.now() - 60_000;
  const t = await add(slug, 'work');
  await move(t.key, 'doing');
  await auto.tickAutomations(app, t0);
  await move(t.key, 'review');
  await auto.tickAutomations(app, t0 + 1000);
  await auto.tickAutomations(app, t0 + 2000);
  const c = checks(slug)[0];
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(c.id, CHECK_SID);
  await app.inject({ method: 'PATCH', url: `/api/tasks/${t.key}`, payload: { status: 'todo' }, headers: { host: '127.0.0.1:3100', 'x-claude-session': CHECK_SID } });
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(c.id);
  limits(100);
  hooks.launches.length = 0;
  await auto.tickAutomations(app, Date.now());
  assert.equal(hooks.launches.length, 0, 'a fix started at a used-up limit');
  kvSet('claude.limits', '');
  await auto.tickAutomations(app, Date.now());
  assert.equal(hooks.launches.length, 1, 'the fix did not start after the reset');
  assert.equal(JSON.parse(rule(id).rounds)[t.id].n, 1);
  await dropAll(slug);
});

test('the queue holds at 80 % of the real reading and goes under it', async () => {
  const slug = project();
  await add(slug, 'next');
  const id = (await arm(slug, QUEUE)).json().id;
  limits(80);
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await auto.tickAutomations(app, t0 + 1000);
  assert.equal(JSON.parse(rule(id).fires).length, 0, 'a queue started at 80 %');
  limits(79.9); // the same window takes only a higher figure in takeReading; the kv is written directly here
  await auto.tickAutomations(app, t0 + 2000);
  await auto.tickAutomations(app, t0 + 3000);
  assert.equal(JSON.parse(rule(id).fires).length, 1, 'a queue did not start under 80 %');
  kvSet('claude.limits', '');
  await dropAll(slug);
});

test('the grooming names no task to the start', async () => {
  const slug = project();
  await add(slug, 'an idea', 'backlog');
  const d = new Date(); d.setSeconds(0, 0);
  const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  await inject('POST', '/api/automations', { project: slug, kind: 'schedule-groom', plan: { at, day: null }, words: { run: 'Run', groom: 'Groom (grooming mode):' } });
  hooks.launches.length = 0;
  await auto.tickAutomations(app, Date.now());
  assert.equal(hooks.launches.length, 1, 'the grooming did not start');
  assert.equal(hooks.launches[0].keys, undefined, 'a key in the start moves the task to Preparation');
  await dropAll(slug);
});

test('a queue does not take a task the fix gave up on', async () => {
  const slug = project();
  const fix = (await arm(slug, { repeat: true, fix: true, delay_min: 120, words: { ...WORDS, back: 'Return it.' } })).json().id;
  const lost = await add(slug, 'gave up');
  db.prepare('UPDATE automations SET rounds = ? WHERE id = ?').run(JSON.stringify({ [lost.id]: { n: 2, at: Date.now() } }), fix);
  const free = await add(slug, 'free');
  await arm(slug, QUEUE);
  hooks.launches.length = 0;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0);
  await auto.tickAutomations(app, t0 + 1000);
  assert.equal(hooks.launches.length, 1);
  assert.deepEqual(hooks.launches[0].keys, [free.key], 'the queue took what waits for the person');
  await dropAll(slug);
});

test('CK-939: a refused batch counts down to its next try, not 0:00 for five minutes', async () => {
  const slug = project();
  await add(slug, 'next');
  const id = (await arm(slug, { ...QUEUE, repeat: true })).json().id;
  const seen = async () => (await inject('GET', '/api/automations')).json().rules.find((r) => r.id === id);
  const t0 = Date.now();
  await auto.tickAutomations(app, t0); // ready
  assert.equal((await seen()).due_at, t0, 'without a refusal the countdown is the pause of the rule');
  db.prepare('UPDATE projects SET path = NULL WHERE slug = ?').run(slug);
  await auto.tickAutomations(app, t0 + 1000); // the start is refused
  assert.match(rule(id).error, /no-folder/);
  await auto.tickAutomations(app, t0 + 2000); // ready again, and its pause is over at once
  const r = await seen();
  assert.equal(r.phase, 'ready');
  assert.equal(r.due_at, t0 + 1000 + 5 * 60_000);
  await dropAll(slug);
});

test('a refused batch sends no start until its pause is over, and the error goes with the next one', async () => {
  const slug = project();
  await add(slug, 'next');
  const id = (await arm(slug, { ...QUEUE, repeat: true })).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0); // ready
  db.prepare('UPDATE projects SET path = NULL WHERE slug = ?').run(slug);
  hooks.launches.length = 0;
  await auto.tickAutomations(app, t0 + 1000); // the start is refused
  assert.equal(hooks.launches.length, 1);
  await auto.tickAutomations(app, t0 + 2000); // ready again: its own pause of 0 min is over at the next look
  await auto.tickAutomations(app, t0 + 3000);
  await auto.tickAutomations(app, t0 + 1000 + 5 * 60_000 - 1);
  assert.equal(hooks.launches.length, 1, 'a start was tried in the middle of the pause');
  db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run(folder, slug);
  await auto.tickAutomations(app, t0 + 1000 + 5 * 60_000 + 1);
  assert.equal(hooks.launches.length, 2, 'the pause never ended');
  assert.equal(rule(id).error, null, 'the error outlived a start that went');
  await dropAll(slug);
});

test('a batch held by a Claude already at it says so in words the page knows', async () => {
  const slug = project();
  const t = await add(slug, 'next');
  const id = (await arm(slug, { ...QUEUE, repeat: true })).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0); // ready
  const busy = { inject: async (o) => (o.url !== '/api/launch' ? app.inject(o) : { statusCode: 409, json: () => ({ error: `Claude of the board already works on ${t.key}`, running: [t.key] }) }) };
  await auto.tickAutomations(busy, t0 + 1000);
  assert.match(rule(id).error, /^running: /, 'the refusal lost what it was');
  const { failWord } = await import('../public/js/review-rules.js');
  const word = failWord(rule(id).error);
  assert.ok(word, 'the page shows the raw English line on a Russian board');
  await dropAll(slug);
});

test('every refusal of a start the page words has its translation', async () => {
  const { failWord } = await import('../public/js/review-rules.js');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const reason of ['no-folder', 'no-tmux', 'no-claude', 'too-long', 'check-open', 'manual', 'running', 'tmux-slow']) {
    const word = failWord(`${reason}: the English of the server`);
    assert.ok(word, `${reason} has no words`);
    assert.ok(core.includes(`'${word}':`) || core.includes(`"${word}":`), `«${word}» is not in the dictionary`);
  }
  assert.equal(failWord('Claude did not start (500)'), null, 'a line that is no refusal stays as it is');
  assert.equal(failWord(null), null);
});

test('a queue taken off by the look of another rule starts nothing', async () => {
  const a = project();
  const b = project();
  await add(a, 'first'); await add(b, 'second');
  const first = (await arm(a, QUEUE)).json().id;
  const second = (await arm(b, QUEUE)).json().id;
  const t0 = Date.now();
  await auto.tickAutomations(app, t0); // both ready
  hooks.launches.length = 0;
  hooks.onLaunch = (body) => { if (body.project === a) auto.dropRule(second, Date.now()); };
  await auto.tickAutomations(app, t0 + 1000);
  hooks.onLaunch = null;
  assert.equal(hooks.launches.length, 1, 'a rule taken off started its batch');
  assert.equal(rule(first).state, 'armed');
  await dropAll(a);
});

test('a schedule does not run with the automations off', async () => {
  const slug = project();
  const t = await add(slug, 'in review');
  await move(t.key, 'doing'); await move(t.key, 'review');
  db.prepare("UPDATE tasks SET updated_at = datetime('now', '-1 day') WHERE id = ?").run(t.id);
  const d = new Date();
  const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  await inject('POST', '/api/automations', { project: slug, kind: 'schedule-check', plan: { at, day: null }, words: WORDS });
  auto.setAutomationsOn(false);
  await auto.tickAutomations(app, Date.now());
  assert.equal(checks(slug).length, 0, 'a run with the switch off');
  auto.setAutomationsOn(true);
  await dropAll(slug);
});

test('the walk over the folders is once a day: a file grown an hour later waits', async () => {
  const h = await import('../src/auto-health.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kb-accept-heavy-')));
  const slug = project(dir);
  const tasks = () => db.prepare('SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = ?').all(slug);
  await inject('PUT', '/api/automations/extras', { health: true });
  const at = Date.now();
  await auto.tickAutomations(app, at);
  writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(40_001));
  await auto.tickAutomations(app, at + 3600_000);
  assert.equal(tasks().length, 0, 'the folders were walked again within the day');
  await auto.tickAutomations(app, at + h.HEALTH_EVERY_MS + 1000);
  assert.equal(tasks().length, 1);
  await inject('PUT', '/api/automations/extras', { health: false });
  rmSync(dir, { recursive: true, force: true });
});

test('DEFECT: a blocked task waits for the person, so its session is not brought back', async () => {
  const r = await import('../src/auto-resume.js');
  const slug = project();
  const t = await add(slug, 'blocked');
  await move(t.key, 'doing');
  await inject('PATCH', `/api/tasks/${t.key}`, { blocked: true, blocked_reason: 'waits for an answer' });
  const sid = 'eeeeeeee-2000-4000-8000-eeeeeeeeeeee';
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(t.id, sid);
  r.resetResume();
  r.setResumeDeps({ runs: async () => ({ runs: [{ session: sid, claude: 'gone', tasks: [{ key: t.key, status: 'doing' }] }] }), turn: async () => ({ open: true, items: [{ kind: 'tool', tool: 'Bash' }] }), folder: async () => folder });
  await inject('PUT', '/api/automations/extras', { resume: true, launch: { permission: 'auto' } });
  hooks.launches.length = 0;
  await r.tickResume(app, 6e12, {});
  await inject('PUT', '/api/automations/extras', { resume: false });
  assert.equal(hooks.launches.length, 0, 'the board started Claude on a blocked task');
});
