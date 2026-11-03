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
