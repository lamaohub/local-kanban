// another task. The guard has two halves — the queue writes `started_at` before the irreversible call, and the
// and wrote started_at itself, so deleting either half left the whole suite green. Here the real worker and the
// real github.js talk to a stand-in gh (KB_GH_BIN) that keeps a little GitHub in a file: its issue list answers
// at once, its search sees only what the test says is indexed — as GitHub's search lags behind by minutes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, state, db, enqueue, drain, LABELS;
const STATUSES = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review', 'done', 'cancelled'];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  state = join(tmp, 'github.json');
  const gh = join(tmp, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const STATE = ${JSON.stringify(state)};
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args.slice(0, 2).join(' ') + (args.includes('--search') ? ' --search' : ''));
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
// written at once: process.exit right after an asynchronous write to a pipe cuts the answer at 8 KB
const done = (out) => { save(); fs.writeSync(1, out); process.exit(0); };
const fail = (why) => { save(); fs.writeSync(2, why); process.exit(1); };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const [a, b] = args;
if (a === 'auth') done('');
if (a === 'label' && b === 'list') done(JSON.stringify(st.labels.map((name) => ({ name }))));
if (a === 'issue' && b === 'create') {
  if (st.cut === 'before') { st.cut = null; fail('Post "https://api.github.com/graphql": connection reset by peer'); } // GitHub never got it
  const number = ++st.next;
  const issue = { number, url: 'https://github.com/someone/board/issues/' + number, title: flag('--title'), body: flag('--body'), state: 'OPEN', indexed: false };
  st.issues.push(issue);
  if (st.cut === 'after') { st.cut = null; fail('Post "https://api.github.com/graphql": unexpected EOF'); } // made, the answer lost
  done(issue.url + '\\n');
}
if (a === 'issue' && b === 'list') {
  const search = flag('--search');
  let list = st.issues.slice().reverse(); // newest first, as GitHub lists them
  if (search) { const phrase = /"([^"]+)"/.exec(search)[1]; list = list.filter((i) => i.indexed && i.body.includes(phrase)); }
  done(JSON.stringify(list.slice(0, Number(flag('--limit') || 30)).map(({ number, url, body }) => ({ number, url, body }))));
}
if (a === 'issue' && b === 'close') { st.issues.find((i) => i.number === Number(args[2])).state = 'CLOSED'; done(''); }
if (a === 'project' && b === 'item-add') done(JSON.stringify({ id: 'item-' + flag('--url').split('/').pop() }));
if (a === 'project' && b === 'item-edit') done('');
fail('the stand-in gh does not know: ' + args.join(' '));
`);
  chmodSync(gh, 0o755);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_GH_OWNER: 'someone', KB_GH_REPO: 'someone/board', KB_GH_BIN: gh });
  ({ db, enqueue } = await import('../src/db.js'));
  ({ LABELS } = await import('../src/sync/github.js'));
  const worker = await import('../src/sync/worker.js');
  ({ drain } = worker);
  worker.ghState.available = true; worker.ghState.lastCheck = Date.now() + 1e9;
  writeFileSync(state, JSON.stringify({ next: 40, issues: [], calls: [], labels: Object.keys(LABELS), cut: null }));
  // a project already on the GitHub board: ensureProject has nothing to make
  const options = JSON.stringify(Object.fromEntries(STATUSES.map((s) => [s, `opt-${s}`])));
  db.prepare(`INSERT INTO projects (slug, prefix, name, next_task_no, gh_project_number, gh_project_id, gh_status_field_id, gh_status_options)
    VALUES ('demo', 'CK', 'Demo', 20, 7, 'PVT_7', 'PVTF_7', ?)`).run(options);
});

after(() => {
  for (const k of ['KB_GH_OWNER', 'KB_GH_REPO', 'KB_GH_BIN']) delete process.env[k];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const github = () => JSON.parse(readFileSync(state, 'utf8'));
const tweak = (f) => { const st = github(); f(st); writeFileSync(state, JSON.stringify(st)); };
const signed = (key) => github().issues.filter((i) => i.body.includes(`· ${key} ·`));
function addTask(no, description = '') {
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get().id;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status) VALUES (?, ?, ?, ?, 'todo')").run(pid, no, `Task ${no}`, description).lastInsertRowid;
  enqueue('create_issue', id, { task_id: id, key: `CK-${no}`, title: `Task ${no}`, description, labels: [], status: 'todo' });
  return id;
}
// the next drain as if its backoff were over — after a restart of the board, say
const drainNow = async () => { db.prepare("UPDATE sync_queue SET next_attempt_at = datetime('now', '-1 second')").run(); await drain(); };
const issueOf = (id) => db.prepare('SELECT gh_issue_number FROM tasks WHERE id = ?').get(id).gh_issue_number;

test('a create cut off after GitHub made the issue is not made twice, though the search has not indexed it yet', async () => {
  const id = addTask(1);
  tweak((st) => { st.cut = 'after'; });
  await drainNow();
  assert.equal(signed('CK-1').length, 1, 'the stand-in did not make the issue before the answer was lost');
  assert.equal(issueOf(id), null);
  assert.notEqual(db.prepare("SELECT started_at FROM sync_queue WHERE task_id = ? AND op = 'create_issue'").get(id)?.started_at ?? null, null,
    'the queue did not write down that the irreversible call had started');
  await drainNow();
  assert.deepEqual(signed('CK-1').map((i) => i.number), [41], 'a second issue was made for the same task');
  assert.equal(issueOf(id), 41);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE task_id = ?').get(id).n, 0);
});

test('a retry does not take the issue of another task that only mentions its key', async () => {
  const other = addTask(51, 'Related to CK-5: the same header');
  await drainNow();
  const theirs = issueOf(other);
  assert.ok(theirs);
  tweak((st) => { st.issues.forEach((i) => { i.indexed = true; }); }); // made long ago: the search has it too
  const id = addTask(5);
  tweak((st) => { st.cut = 'before'; }); // this time GitHub never got the call
  await drainNow();
  assert.equal(issueOf(id), null);
  assert.deepEqual(signed('CK-5'), []);
  await drainNow();
  const mine = issueOf(id);
  assert.notEqual(mine, theirs, 'CK-5 took the issue of CK-51');
  assert.deepEqual(signed('CK-5').map((i) => i.number), [mine]);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  enqueue('close_issue', id, { task_id: id, key: 'CK-5', status: 'done' });
  await drainNow();
  const now = github().issues;
  assert.equal(now.find((i) => i.number === mine).state, 'CLOSED');
  assert.equal(now.find((i) => i.number === theirs).state, 'OPEN', 'accepting CK-5 closed the issue of CK-51');
});

test('a retry long after the cut finds the issue by the search once it is no longer among the newest', async () => {
  // the newest hundred is the fast path; a retry hours later, after a hundred other issues, needs the search
  const id = addTask(3);
  tweak((st) => { st.cut = 'after'; });
  await drainNow();
  tweak((st) => {
    for (let n = 0; n < 120; n++) st.issues.push({ number: ++st.next, url: `https://github.com/someone/board/issues/${st.next}`, body: `elsewhere ${n}`, state: 'OPEN', indexed: true });
    st.issues.forEach((i) => { i.indexed = true; });
  });
  const made = signed('CK-3').map((i) => i.number);
  await drainNow();
  assert.deepEqual(signed('CK-3').map((i) => i.number), made, 'a second issue was made: the lookup does not fall back to the search');
  assert.equal(issueOf(id), made[0]);
  assert.ok(github().calls.includes('issue list --search'), 'the search was not asked');
});
