// The ops of one task reach GitHub in the order they were made, a close that GitHub refused while the
// issue got closed anyway counts as done, and a gh still running dies with the board. The real worker
// and the real github.js talk to a stand-in gh (KB_GH_BIN) that keeps a little GitHub in a file — the
// real GitHub is never called. Found by an audit with the same kind of stand-in: a close failed once,
// the task went back to work before the retry, and a minute later the retry closed the issue of a task
// in work — the queue empty, no error anywhere.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let tmp, state, gh, db, enqueue, drain, LABELS;
const STATUSES = ['backlog', 'todo', 'prep', 'doing', 'ready', 'deploy', 'review', 'done', 'cancelled'];
const COULD_NOT = 'GraphQL: Could not close the issue. (closeIssue)';
const orphans = [];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-sync-order-'));
  state = join(tmp, 'github.json');
  gh = join(tmp, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const STATE = process.env.KB_TEST_GH_STATE || ${JSON.stringify(state)};
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const args = process.argv.slice(2);
const [a, b, n] = args;
st.calls.push([a, b].join(' '));
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const done = (out) => { save(); fs.writeSync(1, out); process.exit(0); };
const fail = (why) => { save(); fs.writeSync(2, why); process.exit(1); };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const issue = () => st.issues[n] || fail('Could not resolve to an Issue with the number of ' + n);
if (a === 'auth') done('');
if (a === 'label' && b === 'list') done(JSON.stringify(st.labels.map((name) => ({ name }))));
if (a === 'issue' && b === 'create') {
  const no = String(++st.next);
  st.issues[no] = { state: 'OPEN', comments: [] };
  done('https://github.com/someone/board/issues/' + no + '\\n');
}
if (a === 'issue' && b === 'comment') {
  const f = st.fail.comment && st.fail.comment.shift();
  if (f) fail(f);
  if (st.hang === 'comment') { fs.writeFileSync(STATE + '.pid', String(process.pid)); setInterval(() => {}, 1e6); return; }
  issue().comments.push(flag('--body')); done('');
}
if (a === 'issue' && b === 'close') {
  const f = st.fail.close && st.fail.close.shift();
  if (f) { if (f.closes) issue().state = 'CLOSED'; fail(f.msg); } // the workflow of Projects closed it in between
  if (issue().state === 'CLOSED') { save(); fs.writeSync(2, '! Issue #' + n + ' is already closed\\n'); process.exit(0); }
  issue().state = 'CLOSED'; done('');
}
if (a === 'issue' && b === 'reopen') {
  if (issue().state === 'OPEN') { save(); fs.writeSync(2, '! Issue #' + n + ' is already open\\n'); process.exit(0); }
  issue().state = 'OPEN'; done('');
}
if (a === 'issue' && b === 'view') done(JSON.stringify({ state: issue().state }));
if (a === 'project' && b === 'item-add') done(JSON.stringify({ id: 'item-' + flag('--url').split('/').pop() }));
if (a === 'project' && b === 'item-edit') { st.columns[flag('--id')] = flag('--single-select-option-id'); done(''); }
fail('the stand-in gh does not know: ' + args.join(' '));
`);
  chmodSync(gh, 0o755);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_GH_OWNER: 'someone', KB_GH_REPO: 'someone/board', KB_GH_BIN: gh });
  ({ db, enqueue } = await import('../src/db.js'));
  ({ LABELS } = await import('../src/sync/github.js'));
  const worker = await import('../src/sync/worker.js');
  ({ drain } = worker);
  worker.ghState.available = true; worker.ghState.lastCheck = Date.now() + 1e9;
  const options = JSON.stringify(Object.fromEntries(STATUSES.map((s) => [s, `opt-${s}`])));
  db.prepare(`INSERT INTO projects (slug, prefix, name, next_task_no, gh_project_number, gh_project_id, gh_status_field_id, gh_status_options)
    VALUES ('demo', 'CK', 'Demo', 100, 7, 'PVT_7', 'PVTF_7', ?)`).run(options);
});

after(() => {
  for (const pid of orphans) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  for (const k of ['KB_GH_OWNER', 'KB_GH_REPO', 'KB_GH_BIN']) delete process.env[k];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const github = () => JSON.parse(readFileSync(state, 'utf8'));
const tweak = (f) => { const st = github(); f(st); writeFileSync(state, JSON.stringify(st)); };
let no = 0;
beforeEach(() => {
  db.exec('DELETE FROM sync_queue; DELETE FROM app_errors');
  writeFileSync(state, JSON.stringify({ next: 40, issues: {}, columns: {}, calls: [], labels: Object.keys(LABELS), fail: {}, hang: null }));
});

/** A task that already has its issue and its card, as most tasks on a synced board do. */
function addTask(status = 'review', { issue = true } = {}) {
  no++;
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get().id;
  const number = issue ? 500 + no : null;
  const id = db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, gh_issue_number, gh_issue_url, gh_item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(pid, no, `Task ${no}`, status, number,
    number && `https://github.com/someone/board/issues/${number}`, number && `item-${number}`).lastInsertRowid;
  if (number) tweak((st) => { st.issues[number] = { state: 'OPEN', comments: [] }; });
  return { id, number, key: `CK-${no}` };
}
const move = (t, status) => {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
  enqueue(['done', 'cancelled'].includes(status) ? 'close_issue' : 'reopen_issue', t.id, { task_id: t.id, key: t.key, status });
};
const comment = (t, body) => enqueue('add_comment', t.id, { task_id: t.id, key: t.key, comment_author: 'me', comment_body: body });
// the next drain as if every backoff were over
const drainLater = async () => { db.prepare("UPDATE sync_queue SET next_attempt_at = datetime('now', '-1 second')").run(); await drain(); };
const queue = () => db.prepare('SELECT op, task_id, attempts FROM sync_queue ORDER BY id').all();

test('a task taken back from Done while its failed close waits for the retry keeps its issue open', async () => {
  const t = addTask();
  tweak((st) => { st.fail.close = [{ msg: 'Post "https://api.github.com/graphql": connection reset by peer' }]; });
  move(t, 'done');
  await drain();
  assert.equal(github().issues[t.number].state, 'OPEN', 'the stand-in did not refuse the close');
  assert.equal(queue().length, 1, 'the failed close is not waiting for its retry');

  move(t, 'doing'); // before the retry of the close
  await drain();
  await drainLater();
  await drainLater();
  assert.equal(github().issues[t.number].state, 'OPEN', 'the retry of the close closed the issue of a task in work');
  assert.equal(github().columns[`item-${t.number}`], 'opt-doing');
  assert.deepEqual(queue(), []);
});

test('a close and a reopen of one task waiting together leave only the latest', () => {
  const t = addTask();
  move(t, 'done');
  move(t, 'doing');
  assert.deepEqual(queue().map((r) => r.op), ['reopen_issue']);
  move(t, 'cancelled');
  assert.deepEqual(queue().map((r) => r.op), ['close_issue']);
});

test('a later op of a task waits for an earlier one that waits for its retry; other tasks do not', async () => {
  const t = addTask();
  const other = addTask();
  tweak((st) => { st.fail.comment = ['Post "https://api.github.com/graphql": unexpected EOF']; });
  comment(t, 'first');
  comment(t, 'second');
  await drain();
  comment(other, 'elsewhere');
  await drain();
  assert.deepEqual(github().issues[t.number].comments, [], 'the second comment ran ahead of the first that waits');
  assert.deepEqual(github().issues[other.number].comments, ['elsewhere'], 'a task with nothing waiting was held too');
  await drainLater();
  assert.deepEqual(github().issues[t.number].comments, ['first', 'second']);
  assert.deepEqual(queue(), []);
});

test('create_issue is not held by an earlier op of its task that waits for it', async () => {
  // sync switched on after the task was made: the comment comes first and puts create_issue behind itself
  const t = addTask('todo', { issue: false });
  comment(t, 'made before the issue');
  await drain();
  assert.deepEqual(queue().map((r) => r.op), ['add_comment', 'create_issue']);
  await drain(); // the comment still waits for its backoff — the create must not
  const number = db.prepare('SELECT gh_issue_number FROM tasks WHERE id = ?').get(t.id).gh_issue_number;
  assert.ok(number, 'create_issue waited behind the comment that waits for it');
  await drainLater();
  assert.deepEqual(github().issues[number].comments, ['made before the issue']);
});

test('the issue is closed before its card moves to the Done column', async () => {
  const t = addTask();
  move(t, 'done');
  await drain();
  const calls = github().calls;
  assert.ok(calls.indexOf('issue close') >= 0 && calls.indexOf('issue close') < calls.indexOf('project item-edit'),
    `the card moved first, which may start the workflow that closes the issue itself: ${calls.join(', ')}`);
  assert.equal(github().issues[t.number].state, 'CLOSED');
  assert.equal(github().columns[`item-${t.number}`], 'opt-done');
});

test('«Could not close the issue» on an issue that got closed counts as done, on one still open — not', async () => {
  const t = addTask();
  tweak((st) => { st.fail.close = [{ msg: COULD_NOT, closes: true }]; });
  move(t, 'done');
  await drain();
  assert.deepEqual(queue(), [], 'the close of an issue that is closed waits for a retry');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_errors').get().n, 0, 'a close that worked went to the error log');
  assert.equal(github().columns[`item-${t.number}`], 'opt-done');

  const open = addTask();
  tweak((st) => { st.fail.close = [{ msg: COULD_NOT }]; });
  move(open, 'done');
  await drain();
  assert.deepEqual(queue().map((r) => [r.op, r.attempts]), [['close_issue', 1]], 'a close GitHub refused was taken for done');
  assert.equal(github().issues[open.number].state, 'OPEN');
});

test('a gh still running when the board is stopped is stopped with it', async () => {
  const stateCopy = join(tmp, 'hang.json');
  writeFileSync(stateCopy, JSON.stringify({ next: 1, issues: { 9: { state: 'OPEN', comments: [] } }, columns: {}, calls: [], labels: [], fail: {}, hang: 'comment' }));
  const script = join(tmp, 'board.mjs');
  const githubJs = pathToFileURL(fileURLToPath(new URL('../src/sync/github.js', import.meta.url))).href;
  writeFileSync(script, `const { gh } = await import(${JSON.stringify(githubJs)});
gh(['issue', 'comment', '9', '-R', 'someone/board', '--body', 'x']).catch(() => {});
setInterval(() => {}, 1e6);
`);
  const board = spawn(process.execPath, [script], {
    env: { ...process.env, KB_DATA_DIR: join(tmp, 'board'), KB_TEST_GH_STATE: stateCopy }, stdio: 'ignore',
  });
  const exited = new Promise((res) => board.on('exit', (code, signal) => res({ code, signal })));
  const pidFile = `${stateCopy}.pid`;
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(pidFile), 'the stand-in gh never started');
  const ghPid = Number(readFileSync(pidFile, 'utf8'));
  orphans.push(ghPid);
  board.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143, 'the board did not end with the code of SIGTERM');
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(ghPid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the gh the board started outlived it');
});
