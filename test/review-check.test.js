// label and starts Claude on it; the press is the person's word for exactly the tasks the check lists. So a
// project has one open check (two tabs pressing at once made two checks and two Claudes), and the board's Claude
// started on a check may run `kb done` for the tasks it lists — and for nothing else — without asking.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { CHECK_LABEL as PAGE_LABEL, OPEN_CHECK as PAGE_OPEN } from '../public/js/review-rules.js';

let app, tmp, folder, db, check;

const inject = async (method, url, payload) => app.inject({ method, url, payload });
const add = (project, title, status = 'todo', labels = []) => inject('POST', '/api/tasks', { project, title, status, labels });
const move = (key, status) => db.prepare("UPDATE tasks SET status = ? WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(status, key);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-check-')));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-test-check-${process.pid}`; // never the board's own socket
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  check = await import('../src/review-check.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('shop','SH','Shop',1,?)").run(folder);
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('villa','VT','Villa',1,?)").run(folder);
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('the page and the server agree on what a check is and when it is still open', () => {
  assert.equal(check.CHECK_LABEL, PAGE_LABEL);
  assert.deepEqual(check.OPEN_CHECK, PAGE_OPEN);
});

test('the check label is in the palette, so it syncs, but is not offered to put by hand', async () => {
  const r = (await inject('GET', '/api/labels')).json();
  assert.ok(r.palette.check, 'the label is not in the palette: a check would not reach GitHub');
  assert.ok(!r.selectable.includes('check'), 'the label pickers offer the check label');
  assert.ok(r.selectable.includes('noclaude') && r.selectable.includes('ask'), 'other labels went missing from the pickers');
});

test('a project has one open check: the second is refused with the key of the first, other projects are free', async () => {
  const first = await add('shop', 'Check the tasks in Review', 'todo', ['check']);
  assert.equal(first.statusCode, 201, first.body);
  const key = first.json().key;
  const second = await add('shop', 'Check the tasks in Review', 'todo', ['check']);
  assert.equal(second.statusCode, 409, 'a second open check was made in the same project');
  assert.deepEqual({ reason: second.json().reason, key: second.json().key }, { reason: 'check-open', key });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE labels LIKE '%\"check\"%'").get().n, 1, 'the refused check was written anyway');
  assert.equal((await add('villa', 'Check the tasks in Review', 'todo', ['check'])).statusCode, 201, 'another project was refused its own check');
  assert.equal((await add('shop', 'An ordinary task', 'todo', ['bug'])).statusCode, 201, 'an ordinary task was refused while a check is open');
  // in work it is still open; handed in to Review it is a report, and a new check may start
  for (const status of ['prep', 'doing', 'deploy']) {
    move(key, status);
    assert.equal((await add('shop', 'again', 'todo', ['check'])).statusCode, 409, `a check in ${status} let a second one in`);
  }
  move(key, 'review');
  const next = await add('shop', 'Check the tasks in Review', 'todo', ['check']);
  assert.equal(next.statusCode, 201, 'the report of an earlier check blocks a new one');
  move(next.json().key, 'done');
});

test('two presses at once make one check', async () => {
  const [a, b] = await Promise.all([add('villa', 'one', 'todo', ['check']), add('villa', 'two', 'todo', ['check'])]);
  // villa already has an open check from the test above: both are refused with its key
  assert.deepEqual([a.statusCode, b.statusCode], [409, 409]);
  const open = check.openCheck(db.prepare("SELECT id FROM projects WHERE slug = 'villa'").get().id);
  assert.equal(a.json().key, open.key);
  move(open.key, 'cancelled');
  const [c, d] = await Promise.all([add('villa', 'one', 'todo', ['check']), add('villa', 'two', 'todo', ['check'])]);
  assert.deepEqual([c.statusCode, d.statusCode].sort(), [201, 409]);
});

test('Claude started on a check may move exactly the tasks it lists that are in Review to Done', async () => {
  const keyOf = async (title, status = 'todo', labels = []) => { const r = await add('shop', title, 'todo', labels); move(r.json().key, status); return r.json().key; };
  const r1 = await keyOf('ready one', 'review');
  const r2 = await keyOf('ready two', 'review');
  const busy = await keyOf('still in work', 'doing');
  const done = await keyOf('accepted already', 'done');
  const report = await keyOf('the report of an earlier check', 'review', ['check']);
  const other = (await add('villa', 'a task of another project', 'todo')).json().key;
  move(other, 'review');
  const outside = await keyOf('in Review, not listed', 'review');
  // the shop's earlier checks are closed: this one is the open one
  db.prepare("UPDATE tasks SET status = 'done' WHERE labels LIKE '%\"check\"%' AND status != 'review' AND project_id = (SELECT id FROM projects WHERE slug = 'shop')").run();
  const made = await inject('POST', '/api/tasks', {
    project: 'shop', title: 'Check', status: 'todo', labels: ['check'],
    // X${outside}: a key of a project whose prefix ends with this one's — it names no task of this project
    description: `Tasks in Review when the check was started: ${r1}, ${r2.toLowerCase()}, ${busy}, ${done}, ${report}, ${other}, ${r1}, X${outside}\n\nLater ones are not part of it.`,
  });
  assert.equal(made.statusCode, 201, made.body);
  const key = made.json().key;
  const r = await inject('POST', '/api/launch', { mode: 'board', text: `do ${key}`, project: 'shop', keys: [key] });
  assert.equal(r.statusCode, 200, r.body);
  const args = r.json().args;
  const done_ = args.filter((a) => /^Bash\(kb done\b/.test(a));
  assert.deepEqual(done_.sort(), [`Bash(kb done ${r1})`, `Bash(kb done ${r2})`].sort(),
    'kb done went without asking for a task the check does not list, is not in Review, or is of another project');
  assert.ok(!done_.some((a) => a.includes(outside)), 'a task in Review the check does not list was let through');
  // the rules go in the list of --allowedTools, before --permission-mode: after it they would be read as the prompt
  assert.ok(args.indexOf(`Bash(kb done ${r1})`) < args.indexOf('--permission-mode'));
  assert.ok(args.indexOf('--allowedTools') < args.indexOf(`Bash(kb done ${r1})`));
});

test('Claude started on an ordinary task gets no kb done at all, even when it names tasks in Review', async () => {
  const ready = (await add('shop', 'ready to accept')).json().key;
  move(ready, 'review');
  const made = await inject('POST', '/api/tasks', { project: 'shop', title: 'an ordinary task', status: 'todo', description: `see ${ready}` });
  const plain = made.json().key;
  const r = await inject('POST', '/api/launch', { mode: 'board', text: `do ${plain}`, project: 'shop', keys: [plain] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().args.filter((a) => /kb done/.test(a)), []);
});

test('a check is not copied into a second open one: the copy is refused with the key of the open check', async () => {
  // the shop has a check open from the tests above, or gets one now: either answer names it
  const open = (await add('shop', 'Check the tasks in Review', 'todo', ['check'])).json().key;
  const dup = await inject('POST', `/api/tasks/${open}/duplicate`);
  assert.equal(dup.statusCode, 409, 'a copy of the open check made a second open check');
  assert.deepEqual({ reason: dup.json().reason, key: dup.json().key }, { reason: 'check-open', key: open });
  const shop = db.prepare("SELECT id FROM projects WHERE slug = 'shop'").get().id;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND labels LIKE '%"check"%' AND status IN ('todo','prep','doing','deploy')`).get(shop).n, 1);
  // an ordinary task is copied as before; a report of a check is copied once no check is open
  const plain = (await add('shop', 'ordinary')).json().key;
  assert.equal((await inject('POST', `/api/tasks/${plain}/duplicate`)).statusCode, 201);
  move(open, 'review');
  const again = await inject('POST', `/api/tasks/${open}/duplicate`);
  assert.equal(again.statusCode, 201, again.body);
  assert.deepEqual(again.json().labels, ['check']);
  move(again.json().key, 'done');
});

test('the card opens the running check when its copy is refused, and says nothing else', async () => {
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const at = drawer.indexOf('async function duplicateTask(');
  assert.ok(at >= 0, 'duplicateTask is gone from drawer.js');
  const calls = { opened: [], said: [], refused: [] };
  const box = {
    closeDrawerMenu() {}, closeCardMenu() {}, seg: (s) => s, tr: (s) => s, refresh: async () => {},
    api: async () => { throw Object.assign(new Error('SH-1 is already checking this project'), { status: 409, body: { reason: 'check-open', key: 'SH-1' } }); },
    openDrawer: (k) => calls.opened.push(k), styledAlert: (m) => calls.said.push(m), sayRefused: (e) => calls.refused.push(e.message),
  };
  vm.runInNewContext(drawer.slice(at, drawer.indexOf('\n}\n', at) + 2), box);
  await box.duplicateTask('SH-7');
  assert.deepEqual(calls.opened, ['SH-1'], 'the card of the running check is not opened');
  assert.deepEqual([calls.said, calls.refused], [[], []], 'a refusal is said instead of opening the running check');
});
