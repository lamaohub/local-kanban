// Deploying past the column. The real routes and the real `bin/kb`.
// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { bin } from '../src/bin-path.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base, n = 0;
const inject = (method, url, payload) => app.inject({ method, url, payload });
const task = (slug, status, labels = '[]') => {
  const pid = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
  n += 1;
  db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, ?, ?, ?, ?)').run(pid, n, 'Work', status, labels);
  return `${slug === 'gated' ? 'GT' : 'DM'}-${n}`;
};
const move = (key, status) => inject('PATCH', `/api/tasks/${key}`, { status });
const gate = (on) => inject('PUT', '/api/flow', { ready_gate: on });
const kb = (args) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',900)").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('gated','GT','Gated',900)").run();
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('off by default: a task goes to Deploying as before, and the board says the switch is off', async () => {
  assert.equal((await inject('GET', '/api/flow')).json().ready_gate, false);
  assert.equal((await move(task('demo', 'doing'), 'deploy')).statusCode, 200);
  const list = (await inject('GET', '/api/projects')).json();
  assert.equal(list.find((p) => p.slug === 'demo').ship_gate, false);
});

test('on: Deploying only through the column, from any status, with words that say what to do', async () => {
  await gate(true);
  for (const from of ['doing', 'prep', 'review']) {
    const key = task('demo', from);
    const r = await move(key, 'deploy');
    assert.equal(r.statusCode, 409, from);
    assert.equal(r.json().reason, 'ready-first');
    assert.match(r.json().error, new RegExp(`kb mv ${key} ready`));
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).status, from, 'moved all the same');
  }
  const key = task('demo', 'doing');
  assert.equal((await move(key, 'ready')).statusCode, 200);
  assert.equal((await move(key, 'deploy')).statusCode, 200);
  assert.equal((await move(key, 'deploy')).statusCode, 200, 'a second word in Deploying is no skipping');
  assert.equal((await move(key, 'review')).statusCode, 200);
  await gate(false);
});

test('on: Doing does not skip to Review, and what has nothing to ship still goes', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  const r = await move(key, 'review');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'ready-first');
  const refused = await kb(['review', key, 'all done']);
  assert.equal(refused.code, 2);
  const id = db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n, 0, 'a refused move left its note');
  assert.equal((await move(key, 'ready')).statusCode, 200);
  assert.equal((await move(key, 'review')).statusCode, 200, 'nothing to ship: from the column straight to Review');
  assert.equal((await move(task('demo', 'prep'), 'review')).statusCode, 200, 'a question answered in Prep has no code to ship');
  assert.equal((await move(task('demo', 'doing', '["check"]'), 'review')).statusCode, 200, 'the report of a check was held at the gate');
  await gate(false);
  assert.equal((await move(task('demo', 'doing'), 'review')).statusCode, 200, 'off, nothing is held');
});

test('words typed to a task in Review and undone put it back, gate or no gate', async () => {
  const { moveTyped } = await import('../src/routes/tasks.js');
  const sid = 'aaaaaaaa-1111-4222-8333-444444444444';
  const key = task('demo', 'review');
  const other = task('demo', 'todo');
  const row = (k) => db.prepare('SELECT * FROM tasks WHERE task_no = ?').get(Number(k.split('-')[1]));
  await gate(true);
  moveTyped(row(key), sid);
  assert.equal(row(key).status, 'doing');
  await app.inject({ method: 'PATCH', url: `/api/tasks/${other}`, payload: { status: 'prep' }, headers: { 'x-claude-session': sid } });
  assert.equal(row(key).status, 'review', 'the board left the task in Doing: undoing the words was refused');
  await gate(false);
});

test('kb says the refusal with code 2 and moves through ready by its short name', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  const r = await kb(['mv', key, 'deploy']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /goes to ready first/);
  assert.equal((await kb(['mv', key, 'ready'])).stdout.trim(), `${key} ready`);
  assert.equal((await kb(['mv', key, 'dp'])).code, 0);
  const info = await kb(['info', 'demo']);
  assert.match(info.stdout, /ships on the word/);
  await gate(false);
  assert.doesNotMatch((await kb(['info', 'demo'])).stdout, /ships on the word/);
});

test('a project has its own word over the board, both ways, and null gives it back', async () => {
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: 1 })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 409);
  assert.equal((await move(task('demo', 'doing'), 'deploy')).statusCode, 200, 'the word of one project held another');
  await gate(true);
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: 0 })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 200);
  assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: null })).statusCode, 200);
  assert.equal((await move(task('gated', 'doing'), 'deploy')).statusCode, 409);
  await gate(false);
  for (const v of [2, 'yes', true]) assert.equal((await inject('PATCH', '/api/projects/gated', { ready_gate: v })).statusCode, 400);
});

test('a task done by hand does not wait: the person is the word', async () => {
  await gate(true);
  assert.equal((await move(task('demo', 'doing', '["noclaude"]'), 'deploy')).statusCode, 200);
  await gate(false);
});

test('Prep is no way round: a task that has been in Doing holds code, a question answered in Prep does not', async () => {
  await gate(true);
  for (const path of [['prep'], ['todo', 'prep']]) {
    const key = task('demo', 'doing');
    db.prepare("INSERT INTO task_events (task_id, status) SELECT id, 'doing' FROM tasks WHERE task_no = ?").run(Number(key.split('-')[1]));
    for (const s of path) assert.equal((await move(key, s)).statusCode, 200, s);
    const r = await move(key, 'review');
    assert.equal(r.statusCode, 409, `doing → ${path.join(' → ')} → review went past the column`);
    assert.equal(r.json().reason, 'ready-first');
  }
  const asked = task('demo', 'todo');
  await move(asked, 'prep');
  assert.equal((await move(asked, 'review')).statusCode, 200, 'a question answered in Prep was held');
  const back = task('demo', 'doing');
  db.prepare("INSERT INTO task_events (task_id, status) SELECT id, 'doing' FROM tasks WHERE task_no = ?").run(Number(back.split('-')[1]));
  await move(back, 'ready'); await move(back, 'review'); await move(back, 'todo'); await move(back, 'prep');
  assert.equal((await move(back, 'review')).statusCode, 200, 'sent back from Review and answered in Prep: nothing new to ship');
  await gate(false);
});

test('a label is no way past the column: not put on a task in work, and the labels of the request free nothing', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  const row = () => db.prepare('SELECT status, labels FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1]));
  for (const label of ['noclaude', 'check']) {
    const r = await inject('PATCH', `/api/tasks/${key}`, { labels_add: [label] });
    assert.equal(r.statusCode, 409, `+${label} on a task in Doing`);
    assert.equal(r.json().reason, 'ready-first');
    assert.deepEqual(r.json().labels, [], 'the card cannot go back to what the server holds');
    assert.equal((await inject('PATCH', `/api/tasks/${key}`, { labels: [label] })).statusCode, 409, 'the whole set is the same word');
    const both = await inject('PATCH', `/api/tasks/${key}`, { status: 'deploy', labels_add: [label] });
    assert.equal(both.statusCode, 409, 'the label freed the move of its own request');
  }
  const fresh = task('demo', 'todo');
  assert.equal((await inject('PATCH', `/api/tasks/${fresh}`, { status: 'deploy', labels_add: ['noclaude'] })).statusCode, 409, 'from To do, with the label of the same request');
  const refused = await kb(['lbl', key, '+noclaude']);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /stops in ready/);
  assert.doesNotMatch(refused.stderr, /todo|backlog/i, 'the refusal points at the road round the column');
  assert.deepEqual(row(), { status: 'doing', labels: '[]' }, 'a refused request left something');
  // what is not a way past it goes on as before
  assert.equal((await inject('PATCH', `/api/tasks/${key}`, { labels_add: ['bug'] })).statusCode, 200, 'any other label');
  assert.equal((await inject('PATCH', `/api/tasks/${key}`, { labels: ['bug'] })).statusCode, 200, 'the autosave of a card sends the set it has');
  const hand = task('demo', 'doing', '["noclaude"]');
  assert.equal((await inject('PATCH', `/api/tasks/${hand}`, { labels_remove: ['noclaude'] })).statusCode, 200, 'a person takes the label off a card done by hand');
  assert.equal((await move(hand, 'deploy')).statusCode, 409, 'and from there the task waits like any other');
  for (const status of ['backlog', 'todo', 'review']) {
    const free = task('demo', status);
    assert.equal((await inject('PATCH', `/api/tasks/${free}`, { labels_add: ['noclaude'] })).statusCode, 200, status);
    assert.equal((await inject('PATCH', `/api/tasks/${free}`, { labels_remove: ['noclaude'] })).statusCode, 200, status);
  }
  await gate(false);
  assert.equal((await inject('PATCH', `/api/tasks/${key}`, { labels_add: ['noclaude'] })).statusCode, 200, 'off, nothing is held');
});

test('whether a project waits is the owner\'s word, the switch of the board and its own alike', async () => {
  const { ownerOnly } = await import('../src/share.js');
  const guest = { 'x-kb-guest': '1' };
  assert.equal(ownerOnly('PUT', '/api/flow'), true, 'a guest switches the board');
  const edit = (payload, headers) => app.inject({ method: 'PATCH', url: '/api/projects/gated', payload, headers });
  const r = await edit({ ready_gate: 0 }, guest);
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().reason, 'guest');
  assert.equal(db.prepare("SELECT ready_gate FROM projects WHERE slug = 'gated'").get().ready_gate, null);
  assert.equal((await edit({ description: 'a guest may' }, guest)).statusCode, 200, 'the rest of a project stays open to a guest');
  assert.equal((await edit({ description: 'the settings send it all', ready_gate: null }, guest)).statusCode, 200, 'the form of a project sends the word as it stands');
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers: guest, payload: { slug: 'g2', name: 'g2', ready_gate: 0 } })).statusCode, 403);
  assert.equal((await edit({ ready_gate: 0 })).statusCode, 200, 'the owner');
  assert.deepEqual((await inject('GET', '/api/flow')).json().own_off, ['Gated']);
  await edit({ ready_gate: null });
});

test('the column is one of the statuses a task in it hangs its commit on', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'kb-gate-'));
  const git = (...a) => execFileSync(bin('git'), ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'first');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('hung','HG','Hung',9,?)").run(repo).lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status, work_started_at) VALUES (?, 1, 'Work', 'doing', datetime('now', '-1 hour'))").run(pid).lastInsertRowid;
  git('commit', '-q', '--allow-empty', '-m', 'the work');
  await inject('PATCH', '/api/tasks/HG-1', { status: 'ready' });
  const hung = () => db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'git'").get(id);
  for (let i = 0; i < 200 && !hung(); i += 1) await new Promise((r) => { setTimeout(r, 25); });
  assert.match(hung()?.body || '', /the work/, 'no commit on a card in the column');
  await inject('PATCH', '/api/tasks/HG-1', { status: 'review' });
  rmSync(repo, { recursive: true, force: true });
});

test('a question of Claude waiting for the word finds its task', async () => {
  const { taskOfSession } = await import('../src/claude-asks.js');
  const sid = 'bbbbbbbb-1111-4222-8333-444444444444';
  const key = task('demo', 'doing');
  const id = db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))").run(id, sid);
  await move(key, 'ready');
  assert.equal(taskOfSession(sid)?.key, key, 'a Claude in the column asks with no task');
  const other = 'cccccccc-1111-4222-8333-444444444444';
  const held = task('demo', 'todo');
  await app.inject({ method: 'PATCH', url: `/api/tasks/${held}`, payload: { status: 'prep' }, headers: { 'x-claude-session': other } });
  await app.inject({ method: 'PATCH', url: `/api/tasks/${held}`, payload: { status: 'doing' }, headers: { 'x-claude-session': other } });
  await move(held, 'ready'); // by somebody else: the session's window on the task stays open
  const later = db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(Number(task('demo', 'doing').split('-')[1])).id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now', '+1 hour'), datetime('now', '+1 hour'))").run(later, other);
  assert.equal(taskOfSession(other)?.key, held, 'the task the session is on, in the column, lost to a task it touched later');
  await move(held, 'review');
  await move(key, 'review');
});

test('the page draws the column again when the counts come, and a phone keeps the head of Review inside', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../public/js/sse.js'), /if \(hadReady !== readyInUse\(state\.slug\)\) renderBoard\(\)/, 'an emptied column stays until the next render');
  assert.match(read('../public/style.css'), /\.col-check::after \{ content: ''/, 'the button of the check has no finger-wide tap');
  assert.doesNotMatch(read('../public/style.css'), /\.drawer-head-actions, \.col-head \{ gap: 12px; \}/, 'three buttons and a title do not fit a column of 230');
});

test('where the status shows, by the pure rules of the page', async () => {
  const { activeTotal, boardColumns, flowNote, handedIn, readyShown, statusesShown, waitingForWord } = await import('../public/js/ready-rules.js');
  const on = { slug: 'a', ship_gate: true };
  const left = { slug: 'b', c_ready: 1 };
  const off = { slug: 'c' };
  assert.deepEqual([on, left, off].map((p) => readyShown([on, left, off], p.slug, '*')), [true, true, false]);
  assert.equal(readyShown([off], '*', '*'), false, 'all projects: none uses it');
  assert.equal(readyShown([off, left], '*', '*'), true);
  const all = [['doing', 'D'], ['ready', 'R'], ['review', 'V']];
  assert.deepEqual(statusesShown(all, 'doing', false).map(([v]) => v), ['doing', 'review'], 'a menu offered the status with the switch off');
  assert.deepEqual(statusesShown(all, 'ready', false).map(([v]) => v), ['doing', 'ready', 'review'], 'a task in it keeps its status');
  assert.deepEqual(statusesShown(all, 'doing', true).map(([v]) => v), ['doing', 'ready', 'review']);
  const keys = ['doing', 'ready', 'review', 'cancelled'];
  assert.deepEqual(boardColumns(keys, [], false), ['doing', 'review'], 'the column stayed with nothing to show');
  assert.deepEqual(boardColumns(keys, [], true), ['doing', 'ready', 'review']);
  assert.deepEqual(boardColumns(keys, [{ status: 'ready' }], false), ['doing', 'ready', 'review'], 'a task lost its column');
  assert.deepEqual(boardColumns(keys, [{ status: 'cancelled' }], false), ['doing', 'review', 'cancelled']);
  assert.equal(activeTotal([{ c_todo: 1, c_prep: 1, c_doing: 1, c_ready: 1, c_deploy: 1, c_review: 1, c_done: 9 }]), 6, 'the sum of the sidebar lost a column');
  assert.equal(waitingForWord([{ c_ready: 2 }, {}, { c_ready: 1, c_review: 5 }]), 3);
  assert.deepEqual(['ready', 'review', 'done', 'doing'].map(handedIn), [true, true, true, false]);
  const { FEATURES, featuresFor } = await import('../public/js/onboarding-rules.js');
  assert.deepEqual(featuresFor(false), FEATURES, 'off, the wizard speaks of a status the board does not show');
  assert.match(featuresFor(true).find((f) => f.id === 'accept').note, /Ready to ship/, 'on, the wizard hides the column');
  const t = (s) => s;
  assert.match(flowNote({ ready_gate: true, ready_n: 0, own_off: ['Alpha', 'Beta'] }, t), /do not wait: Alpha, Beta/);
  assert.equal(flowNote({ ready_gate: false, ready_n: 0, own_off: ['Alpha'] }, t), '', 'off, no project is an exception');
  assert.match(flowNote({ ready_gate: false, ready_n: 2, left_n: 2, own_off: [] }, t), /the column goes once it is empty.*2/);
});

test('the dashboard says what waits for the word, the rest of the journal says it was handed in', async () => {
  const dash = (await import('../src/routes/dashboard.js')).default;
  const one = Fastify();
  await one.register(dash);
  await gate(true);
  const key = task('demo', 'doing');
  await move(key, 'ready');
  const d = (await one.inject({ method: 'GET', url: '/api/dashboard?range=week' })).json();
  assert.ok(d.waiting.ready.some((t) => t.key === key), 'a task in the column is seen nowhere');
  assert.ok(!d.waiting.review.some((t) => t.key === key));
  const { awaySummary } = await import('../src/automations.js');
  const s = await awaySummary(Date.now() - 60_000, []);
  assert.ok(s.handed.tasks.some((t) => t.key === key), 'the summary lost a task handed in to the column');
  await move(key, 'review');
  await gate(false);
  await one.close();
});

test('the column is not a way past work, the clock stops in it and goes on in Deploying', async () => {
  assert.equal((await move(task('demo', 'todo'), 'ready')).statusCode, 400);
  assert.equal((await move(task('demo', 'backlog'), 'ready')).statusCode, 400);
  const key = task('demo', 'doing');
  const row = () => db.prepare('SELECT status, work_started_at FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1]));
  db.prepare("UPDATE tasks SET work_started_at = datetime('now') WHERE task_no = ?").run(Number(key.split('-')[1]));
  await move(key, 'ready');
  assert.equal(row().work_started_at, null, 'the clock runs while the task waits for the word');
  await move(key, 'deploy');
  assert.ok(row().work_started_at, 'the clock does not start again for the shipping');
});

test('switched off with tasks in the column: they stay, and the board counts them', async () => {
  await gate(true);
  const key = task('demo', 'doing');
  await move(key, 'ready');
  const r = await gate(false);
  assert.ok(r.json().ready_n >= 1);
  assert.equal(r.json().left_n, r.json().ready_n, 'the column would go without them');
  await inject('PATCH', '/api/projects/demo', { ready_gate: 1 });
  assert.equal((await inject('GET', '/api/flow')).json().left_n, 0, 'a project that waits keeps its column');
  await inject('PATCH', '/api/projects/demo', { ready_gate: null });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE task_no = ?').get(Number(key.split('-')[1])).status, 'ready');
  assert.equal((await inject('GET', '/api/projects')).json().find((p) => p.slug === 'demo').c_ready >= 1, true);
  assert.equal((await move(key, 'deploy')).statusCode, 200, 'a task left in the column cannot go on');
});

test('a task in the column stays a task of its session: Claude now and the sweep of terminals keep it', async () => {
  const { STAGE_PERCENT } = await import('../src/claude-now.js');
  assert.equal(STAGE_PERCENT.ready, 65);
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../src/phantom.js'), /const AT_WORK = new Set\(\[[^\]]*'ready'/, 'a Claude waiting for the word is closed as resting');
  assert.match(read('../src/claude-now.js'), /t\.status IN \('todo','ready','review','done'\)/, 'the task drops out of its run');
  assert.match(read('../public/js/sse.js'), /realTransition\(ev, 'review'\) \|\| realTransition\(ev, 'ready'\)\) playReviewSound/, 'nothing says a task waits for the word');
});

test('the switch takes only a yes or a no', async () => {
  assert.equal((await inject('PUT', '/api/flow', { ready_gate: 'on' })).statusCode, 400);
  assert.equal((await inject('PUT', '/api/flow', {})).statusCode, 400);
});
