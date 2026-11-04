// no terminal works in that folder». The real routes (tasks, health) over a project folder with a CLAUDE.md, and Claude
// Code's registry written into a stand-in Claude folder: a live Claude is this very process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let tmp, app, db, folder, claude, health, host;
const sessionsDir = () => join(claude, 'sessions');
let n = 0;
/** A Claude of Claude Code's registry: in `cwd`, with `status`; `pid` — alive (this process) or not. */
function claudeAt(cwd, status, pid = process.pid) {
  n += 1;
  writeFileSync(join(sessionsDir(), `${n}.json`), JSON.stringify({ pid, sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, cwd, status, updatedAt: Date.now() }));
}
const clearClaudes = () => { rmSync(sessionsDir(), { recursive: true, force: true }); mkdirSync(sessionsDir(), { recursive: true }); };
const fix = (project = 'hf') => app.inject({ method: 'POST', url: '/api/health/fix', headers: { host }, payload: { project } });
const task = (key) => db.prepare("SELECT t.status, t.title, t.description FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(key);

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-hfix-')));
  folder = join(tmp, 'work', 'proj');
  claude = join(tmp, 'claude');
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'CLAUDE.md'), `${'a rule\n'.repeat(250)}`);
  mkdirSync(join(tmp, 'work', 'bare'), { recursive: true });
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_CLAUDE_DIR = claude;
  clearClaudes();
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  health = await import('../src/auto-health.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('hf','HF','Fix me',?,1)").run(folder);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('nb','NB','No CLAUDE.md',?,1)").run(join(tmp, 'work', 'bare'));
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('nf','NF','No folder',?,1)").run(join(tmp, 'gone'));
  app = Fastify();
  const { PORT } = await import('../src/config.js');
  host = `127.0.0.1:${PORT}`;
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/health.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('«Fix» opens the task in To do with the docs and the sizes; pressed again, it takes the same task', async () => {
  const r = await fix();
  assert.equal(r.statusCode, 200, r.body);
  const { key, created } = r.json();
  assert.equal(created, true);
  const t = task(key);
  assert.equal(t.status, 'todo', 'the task waits in the backlog instead of being started');
  assert.match(t.description, /https:\/\/code\.claude\.com\/docs\/en\/memory/, 'the task does not point to the docs');
  assert.match(t.description, /CLAUDE\.md: 1[\s ]750 .*250/, 'the task does not say how large the file is');
  const again = (await fix()).json();
  assert.deepEqual(again, { key, created: false }, 'a second press opened a second task');
});

test('the task the automation left in the backlog is taken to To do, not opened again; one in Review is said', async () => {
  const key = (await fix()).json().key;
  db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  assert.deepEqual((await fix()).json(), { key, created: false });
  assert.equal(task(key).status, 'todo');
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  const r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().key], [409, 'review', key]);
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  const fresh = (await fix()).json();
  assert.equal(fresh.created, true, 'a fix the person cancelled kept «Fix» from opening a new one');
  assert.notEqual(fresh.key, key);
});

test('a Claude at work in the folder holds «Fix»; one at its prompt, one gone, one in the folder above do not', async () => {
  clearClaudes();
  claudeAt(join(folder, 'src'), 'busy');
  let r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().sessions], [409, 'busy', 1], 'a Claude at work in a subfolder did not hold it');
  for (const status of ['waiting', 'shell']) {
    clearClaudes();
    claudeAt(folder, status);
    assert.equal((await fix()).statusCode, 409, `a Claude «${status}» in the folder did not hold it`);
  }
  clearClaudes();
  claudeAt(folder, 'idle');
  claudeAt(folder, 'busy', 999999);
  claudeAt(join(tmp, 'work'), 'busy');
  claudeAt(join(tmp, 'work', 'proj-2'), 'busy');
  r = await fix();
  assert.equal(r.statusCode, 200, `held by a Claude at its prompt, a dead one, or one beside the folder: ${r.body}`);
  clearClaudes();
});

test('a task of the project in work holds «Fix», one done by hand does not; the refusal names it', async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'hf'").get().id;
  const no = db.prepare("SELECT next_task_no AS n FROM projects WHERE id = ?").get(pid).n;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'At work', 'doing')").run(pid, no);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, ?, 'By hand', 'doing', '[\"noclaude\"]')").run(pid, no + 1);
  db.prepare('UPDATE projects SET next_task_no = ? WHERE id = ?').run(no + 2, pid);
  const r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().keys], [409, 'busy', [`HF-${no}`]]);
  assert.match(r.json().error, /^Claude works in the folder of this project/);
  db.prepare("UPDATE tasks SET status = 'review' WHERE project_id = ? AND task_no = ?").run(pid, no);
  assert.equal((await fix()).statusCode, 200);
});

test('no CLAUDE.md, no folder, no such project — said, nothing opened', async () => {
  assert.deepEqual([(await fix('nb')).statusCode, (await fix('nb')).json().reason], [409, 'no-claude-md']);
  assert.deepEqual([(await fix('nf')).statusCode, (await fix('nf')).json().reason], [409, 'no-folder']);
  assert.equal((await fix('nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/health/fix', headers: { host }, payload: { project: ['hf'] } })).statusCode, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug IN ('nb', 'nf')").get().n, 0);
  // the rule of the folder alone: a sibling whose name starts with the folder's is not inside it
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a/proj-2', alive: true, status: 'busy' }, { cwd: '/a/proj/x', alive: true, status: 'busy' }]), 1);
});

test('the Russian count of the task agrees with its number', () => {
  const f = ['строка', 'строки', 'строк'];
  for (const [n, want] of [[1, 'строка'], [2, 'строки'], [4, 'строки'], [5, 'строк'], [11, 'строк'], [12, 'строк'], [14, 'строк'],
    [21, 'строка'], [22, 'строки'], [111, 'строк'], [201, 'строка'], [250, 'строк'], [40001, 'строка'], [40002, 'строки']]) {
    assert.equal(health.ruCount(n, f), want, String(n));
  }
});

test('presses at once open one task: of twenty, the rest take the one the first opened', async () => {
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE title LIKE '% CLAUDE.md'").run(); // the task of «Fix», in either language
  clearClaudes();
  for (let round = 0; round < 3; round += 1) {
    const answers = (await Promise.all(Array.from({ length: 20 }, () => fix()))).map((r) => r.json());
    assert.equal(answers.filter((a) => a.created).length, 1, `round ${round}: ${answers.filter((a) => a.created).length} tasks opened`);
    assert.equal(new Set(answers.map((a) => a.key)).size, 1, 'the presses got different tasks');
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE title LIKE '% CLAUDE.md'").run(); // the task of «Fix», in either language
  }
});

test('a CLAUDE.md within the norms opens nothing — the API too; a long one and a heavy one do', async () => {
  const small = join(tmp, 'work', 'small');
  mkdirSync(small, { recursive: true });
  writeFileSync(join(small, 'CLAUDE.md'), 'two\nlines\n');
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sm','SM','Small',?,1)").run(small);
  const r = await fix('sm');
  assert.deepEqual([r.statusCode, r.json().reason], [409, 'within-norm'], r.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'sm'").get().n, 0);
  writeFileSync(join(small, 'CLAUDE.md'), 'x'.repeat(40001)); // heavy, one line
  assert.equal((await fix('sm')).json().created, true, 'a heavy CLAUDE.md of one line is refused');
});

test('every working status holds «Fix»: prep, doing, ready, deploy', async () => {
  clearClaudes();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'hf'").get().id;
  const no = db.prepare('SELECT next_task_no AS n FROM projects WHERE id = ?').get(pid).n;
  db.prepare('UPDATE projects SET next_task_no = ? WHERE id = ?').run(no + 1, pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'Held', 'todo')").run(pid, no);
  for (const status of ['prep', 'doing', 'ready', 'deploy']) {
    db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND task_no = ?').run(status, pid, no);
    const r = await fix();
    assert.deepEqual([r.statusCode, r.json().keys], [409, [`HF-${no}`]], `a task in ${status} did not hold it`);
  }
  db.prepare("UPDATE tasks SET status = 'review' WHERE project_id = ? AND task_no = ?").run(pid, no);
});

test('the folder is compared as it really is: a project by a link, a Claude in the real folder', async () => {
  const { symlinkSync } = await import('node:fs');
  const link = join(tmp, 'work', 'link-to-proj');
  symlinkSync(folder, link);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('ln','LN','By a link',?,1)").run(link);
  clearClaudes();
  claudeAt(folder, 'busy');
  const r = await fix('ln');
  assert.deepEqual([r.statusCode, r.json().sessions], [409, 1], 'a Claude in the real folder of a linked project did not hold it');
  clearClaudes();
  claudeAt(link, 'busy');
  assert.deepEqual((await fix()).json().sessions, 1, 'a Claude in the link of the folder did not hold it');
  clearClaudes();
});

test('a subfolder whose name begins with two dots is inside the folder', () => {
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a/proj/..hidden', alive: true, status: 'busy' }]), 1);
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a', alive: true, status: 'busy' }, { cwd: '/a/other', alive: true, status: 'busy' }]), 0);
});

test('the page shows «Fix» on a long CLAUDE.md and on a heavy one, not on one within the norms', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const rules = await import('../public/js/health-rules.js');
  const src = readFileSync(new URL('../public/js/health.js', import.meta.url), 'utf8');
  const at = src.indexOf('function projectHTML(');
  const fixAt = src.indexOf('const statusWord =');
  const box = { ...rules, tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), num: String, size: () => '',
    stateHTML: () => '', fileHTML: () => '', opened: new Set(), fixes: {}, STATUS_LABELS: { todo: 'To do', doing: 'Doing', review: 'Review' },
    liveBadge: () => '' };
  vm.createContext(box);
  vm.runInContext(`${src.slice(fixAt, src.indexOf('\n}\n', fixAt) + 2)}\n${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.row = projectHTML;`, box);
  const norms = { lines: 200, file_chars: 40000, total_chars: 120000 };
  const d = { norms, everywhere: { files: [], chars: 0, lines: 0 } };
  const row = (chars, lines) => box.row({ slug: 'x', name: 'X', main: { path: 'CLAUDE.md', chars, lines }, files: [], nested: [], chars, lines }, d);
  assert.match(row(5000, 250), /class="btn-ghost hl-fix"/, 'a long CLAUDE.md has no «Fix»');
  assert.match(row(40001, 10), /class="btn-ghost hl-fix"/, 'a heavy CLAUDE.md has no «Fix»');
  assert.doesNotMatch(row(5000, 150), /hl-fix/, 'a CLAUDE.md within the norms has «Fix»');
  assert.doesNotMatch(box.row({ slug: 'x', name: 'X', main: null, files: [], nested: [], chars: 0, lines: 0 }, d), /hl-fix/);
});

test('the row of a project says what became of its fix: the task, and Claude on it (CK-967)', async () => {
  // the owner: «started, but it is not clear whether the agent works yet» — the row stayed as it was after «Fix»
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const rules = await import('../public/js/health-rules.js');
  const src = readFileSync(new URL('../public/js/health.js', import.meta.url), 'utf8');
  const at = src.indexOf('const statusWord =');
  const live = new Map();
  const box = { ...rules, tr: (s) => s, esc: (s) => String(s), STATUS_LABELS: { todo: 'To do', doing: 'Doing', review: 'Review' },
    liveBadge: (t) => (live.has(t.id) ? `<span class="card-live">${live.get(t.id)}</span>` : '') };
  vm.createContext(box);
  vm.runInContext(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.fix = fixHTML;`, box);
  const BUTTON = '<button class="hl-fix">Fix</button>';
  assert.equal(box.fix(undefined, BUTTON), BUTTON, 'no open fix — the button as before');
  live.set(7, 'working');
  const working = box.fix({ id: 7, key: 'X-7', status: 'doing' }, BUTTON);
  assert.match(working, /data-key="X-7"/, 'the task of the fix is not named');
  assert.match(working, /card-live">working/, "Claude's state on the task is not shown");
  assert.doesNotMatch(working, /hl-fix"/, 'a second «Fix» over a Claude at work');
  assert.match(box.fix({ id: 8, key: 'X-8', status: 'doing' }, BUTTON), /Doing · Claude is not running/, 'a fix in work with nobody on it reads as working');
  const review = box.fix({ id: 9, key: 'X-9', status: 'review' }, BUTTON);
  assert.match(review, /waits for your review/);
  assert.doesNotMatch(review, /hl-fix"/);
  const todo = box.fix({ id: 10, key: 'X-10', status: 'todo' }, BUTTON);
  assert.match(todo, /data-key="X-10"[\s\S]*To do[\s\S]*hl-fix/, 'a fix waiting in To do — the key, the column and the button that starts it');
  assert.equal(rules.fixStage({ status: 'ready' }), 'work');
  assert.equal(rules.fixStage({ status: 'backlog' }), 'todo');
});

test('GET /api/health/fixes names the open fix of each project, the newest, not a done or cancelled one (CK-967)', async () => {
  const RU_TITLE = '\u0423\u0436\u0430\u0442\u044c CLAUDE.md'; // the Russian title of the task, spelt by its code points: the public slice keeps the Russian to the locale
  const { openFixes } = await import('../src/auto-health.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('fixes967', 'FXS', 'Fixes', 5)").run().lastInsertRowid;
  const add = (n, title, status) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, ?)').run(pid, n, title, status);
  add(1, RU_TITLE, 'done');
  add(2, 'Shrink CLAUDE.md', 'review');
  add(3, 'Something else', 'doing');
  assert.deepEqual(openFixes().fixes967, { id: db.prepare("SELECT id FROM tasks WHERE project_id = ? AND task_no = 2").get(pid).id, key: 'FXS-2', status: 'review' });
  add(4, RU_TITLE, 'cancelled');
  assert.equal(openFixes().fixes967.key, 'FXS-2', 'a cancelled fix hid the open one');
  db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ? AND task_no = 2").run(pid);
  assert.equal(openFixes().fixes967, undefined, 'a project with no open fix has one');
});
