import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const SID = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'];
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'test-owner';
  process.env.KB_GH_REPO = 'test-owner/test-repo';
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const run = (args, env = {}) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, ...env };
  if (!env.CLAUDE_CODE_SESSION_ID) delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

let projects = 0;
/** A project with the given To do cards: [{ title, priority, position, pinned, blocked, labels }]. */
function project(cards) {
  const n = ++projects;
  const slug = `p${n}`;
  const pid = db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no) VALUES (?,?,?,?)')
    .run(slug, `PT${n}`, slug, cards.length + 1).lastInsertRowid;
  const add = db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, priority, position, pinned, blocked, labels)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  cards.forEach((c, i) => add.run(pid, i + 1, c.title || `task ${i + 1}`, c.status || 'todo', c.priority || 0,
    c.position ?? i + 1, c.pinned ? 1 : 0, c.blocked ? 1 : 0, JSON.stringify(c.labels || [])));
  return { slug, prefix: `PT${n}`, pid };
}
const firstWord = (out) => out.split('\n')[0].split(' ')[0];
const statusOf = (key) => db.prepare(`SELECT t.status FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE p.prefix || '-' || t.task_no = ?`).get(key).status;

test('take: the pinned card first, then priority and position — the board\'s own order', async () => {
  const p = project([
    { title: 'medium', priority: 2, position: 1 },
    { title: 'pinned, no priority', priority: 0, position: 2, pinned: true },
    { title: 'high', priority: 3, position: 3 },
    { title: 'high but blocked', priority: 3, position: 0, blocked: true },
  ]);
  const next = await run(['next', p.slug]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, new RegExp(`^${p.prefix}-2 todo 📌 pinned, no priority`), `kb next does not point at the task take would take:\n${next.stdout}`);

  const order = [];
  for (let i = 0; i < 3; i++) {
    const r = await run(['take', p.slug]);
    assert.equal(r.code, 0, r.stderr);
    order.push(firstWord(r.stdout));
    if (i === 0) assert.match(r.stdout, new RegExp(`^${p.prefix}-2 prep 📌 `), `the pin is not printed:\n${r.stdout}`);
  }
  assert.deepEqual(order, [`${p.prefix}-2`, `${p.prefix}-3`, `${p.prefix}-1`],
    'kb take ignored the pin (or the priority) — the human pinned a card so that it is taken first');
  const last = await run(['take', p.slug]);
  assert.equal(last.stdout.trim(), 'empty (1 blocked)');
  assert.equal(statusOf(`${p.prefix}-4`), 'todo', 'a blocked task was taken');
});

test('the task list of the API keeps its order: only the take puts the pinned card first', async () => {
  const p = project([
    { title: 'high', priority: 3, position: 1 },
    { title: 'pinned', priority: 0, position: 2, pinned: true },
  ]);
  const list = (await app.inject({ method: 'GET', url: `/api/tasks?project=${p.slug}&status=todo` })).json();
  assert.deepEqual(list.map((t) => t.key), [`${p.prefix}-1`, `${p.prefix}-2`],
    'the order of GET /api/tasks changed for every reader — the owner decided it stays as it was');
  assert.equal(list[1].pinned, 1);
});

test('two takes started together get two different tasks, each with one session', async () => {
  for (let round = 0; round < 8; round++) {
    const p = project([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    const [a, b] = await Promise.all([
      run(['take', p.slug], { CLAUDE_CODE_SESSION_ID: SID[0] }),
      run(['take', p.slug], { CLAUDE_CODE_SESSION_ID: SID[1] }),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const [ka, kb] = [firstWord(a.stdout), firstWord(b.stdout)];
    assert.notEqual(ka, kb, `round ${round}: both sessions took ${ka}`);
    for (const key of [ka, kb]) {
      const t = (await app.inject({ method: 'GET', url: `/api/tasks/${key}` })).json();
      assert.equal(t.status, 'prep');
      assert.equal(t.sessions.length, 1, `${key} is tied to ${t.sessions.length} sessions`);
      assert.equal(t.events.filter((e) => e.status === 'prep').length, 1);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'todo'").get(p.pid).n, 1);
  }
});

test('the take answers like the board: the full card, an empty queue, a project it does not know', async () => {
  const p = project([{ title: 'only one', blocked: true }, { title: 'free' }]);
  const r = await app.inject({ method: 'POST', url: '/api/tasks/take', payload: { project: p.prefix.toLowerCase() } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.task.key, `${p.prefix}-2`, 'the take resolves a project by its prefix too, like every kb command');
  assert.ok(Array.isArray(body.task.checklist) && Array.isArray(body.task.links) && Array.isArray(body.task.events),
    'the answer is not the full card — kb would need a second request for it');
  assert.equal(body.blocked_n, 1);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/tasks/take', payload: { project: p.slug } })).json(), { task: null, blocked_n: 1, by_hand: [] });
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/take', payload: { project: 'no-such-project' } })).statusCode, 404);
  for (const payload of [{}, { project: '' }, { project: 5 }, { project: ['x'] }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/take', payload })).statusCode, 400, JSON.stringify(payload));
  }
});

test('kb ls and kb show print the pin too', async () => {
  const p = project([{ title: 'pinned one', pinned: true, priority: 2 }, { title: 'plain one' }]);
  const ls = await run(['ls', p.slug]);
  assert.match(ls.stdout, new RegExp(`^${p.prefix}-1 todo 📌 p2 pinned one$`, 'm'), ls.stdout);
  assert.match(ls.stdout, new RegExp(`^${p.prefix}-2 todo plain one$`, 'm'), 'a card that is not pinned got a pin');
  const show = await run(['show', `${p.prefix}-1`]);
  assert.match(show.stdout, new RegExp(`^${p.prefix}-1 ${p.slug} todo 📌 p2$`, 'm'), show.stdout);
});

test('ten kb lbl started together keep all ten labels', async () => {
  const labels = ['bug', 'documentation', 'docs', 'duplicate', 'enhancement', 'invalid', 'question', 'wontfix', 'ui', 'feature'];
  for (let round = 0; round < 3; round++) {
    const p = project([{ title: `labels ${round}` }]);
    const key = `${p.prefix}-1`;
    const rs = await Promise.all(labels.map((l, i) => run(['lbl', key, `+${l}`], { CLAUDE_CODE_SESSION_ID: SID[i % 2] })));
    for (const r of rs) assert.equal(r.code, 0, r.stderr);
    const got = (await app.inject({ method: 'GET', url: `/api/tasks/${key}` })).json().labels;
    assert.deepEqual([...got].sort(), [...labels].sort(), `round ${round}: kept ${got.length} of 10 — kb lbl overwrote what its neighbours had added`);
  }
});

test('kb lbl: the last word on a label wins, and a word without + or - is refused', async () => {
  const p = project([{ title: 'words', labels: ['bug'] }]);
  const key = `${p.prefix}-1`;
  let r = await run(['lbl', key, '+ui', '-ui', '-bug', '+bug', '+feature']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${key} [bug,feature]`);
  r = await run(['lbl', key, 'docs']);
  assert.equal(r.code, 2, 'a word without + or - was silently skipped');
  assert.match(r.stderr, /kb lbl <key> \+bug -ui/);
  r = await run(['lbl', key, '+no-such-label']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown labels: no-such-label/);
  // the board trims a label name; kb, checking the answer against what it asked, must ask the same name
  r = await run(['lbl', key, '+ui ', '+ docs', '-feature']);
  assert.equal(r.code, 0, `a padded name was taken for a board on older code: ${r.stderr}`);
  assert.equal(r.stdout.trim(), `${key} [bug,ui,docs]`);
});

test('PATCH labels_add / labels_remove change the set the board has; labels still replaces it', async () => {
  const p = project([{ title: 'api', labels: ['ui', 'legacy-label'] }]);
  const key = `${p.prefix}-1`;
  const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload });
  const queued = () => db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op = 'set_labels'").get().n;

  assert.deepEqual((await patch({ labels_add: ['bug'], labels_remove: ['legacy-label'] })).json().labels, ['ui', 'bug'],
    'a label outside the palette can be removed, and the rest of the set stays');
  db.exec('DELETE FROM sync_queue');
  db.prepare("UPDATE tasks SET updated_at = '2000-01-01 00:00:00' WHERE project_id = ?").run(p.pid);
  assert.deepEqual((await patch({ labels_add: ['bug'], labels_remove: ['docs'] })).json().labels, ['ui', 'bug']);
  assert.equal(queued(), 0, 'a change that changes nothing went to the GitHub queue');
  assert.equal(db.prepare('SELECT updated_at FROM tasks WHERE project_id = ?').get(p.pid).updated_at, '2000-01-01 00:00:00');
  assert.deepEqual((await patch({ labels_add: ['feature'] })).json().labels, ['ui', 'bug', 'feature']);
  assert.equal(queued(), 1, 'a real change did not reach the GitHub queue');

  for (const [payload, why] of [
    [{ labels: ['bug'], labels_add: ['ui'] }, /send one or the other/],
    [{ labels_add: 'bug' }, /labels_add: an array of strings/],
    [{ labels_remove: { a: 1 } }, /labels_remove: an array of strings/],
    [{ labels_add: ['nope'] }, /unknown labels: nope/],
  ]) {
    const r = await patch(payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.match(r.json().error, why);
  }
  // the board itself sends the whole set — that path is unchanged
  assert.deepEqual((await patch({ labels: ['docs'] })).json().labels, ['docs']);
});

test('a kb newer than the board says so instead of a bare "Not Found"', async () => {
  const old = createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 }));
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  try {
    const r = await run(['take', 'demo'], { KB_URL: `http://127.0.0.1:${old.address().port}` });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /does not know POST \/api\/tasks\/take .*restart the board/);
  } finally { old.close(); }
});

test('kb lbl on a board that runs older code says so instead of reporting a change it never made', async () => {
  // The PATCH of a board from before labels_add/labels_remove (updated, but not restarted): the two
  // fields are unknown to it, nothing is updated, and the stored task comes back as is with a 200.
  // kb printed that unchanged set and exited 0, so the label Claude added was simply not there.
  const old = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 7, key: 'OLD-1', project: 'old', status: 'todo', title: 'old board', labels: ['bug'] }));
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${old.address().port}`;
    for (const ops of [['+ui'], ['-bug'], ['+ui', '-bug']]) {
      const r = await run(['lbl', 'OLD-1', ...ops], { KB_URL: url });
      assert.equal(r.code, 2, `kb lbl ${ops.join(' ')} on an old board exited ${r.code}: ${r.stdout}`);
      assert.equal(r.stdout, '', 'kb printed the labels as if the change had been made');
      assert.match(r.stderr, /runs older code than this kb; restart the board/);
    }
    // what was asked is already so — nothing to refuse
    const same = await run(['lbl', 'OLD-1', '+bug'], { KB_URL: url });
    assert.equal(same.code, 0, same.stderr);
    assert.equal(same.stdout.trim(), 'OLD-1 [bug]');
  } finally { old.close(); }
});

const OLDER = ['cccccccc-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'];
const asSession = (sid) => (sid ? { 'x-claude-session': sid } : {});
const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload: { status }, headers: asSession(sid) });
const card = async (key) => (await app.inject({ method: 'GET', url: `/api/tasks/${key}` })).json();
const firstTodo = async (slug, sid) => (await app.inject({ method: 'GET', url: `/api/tasks?project=${slug}&status=todo`, headers: asSession(sid) })).json()
  .find((t) => !t.blocked).key;

test('two takes of an older kb started together: one gets the task, the other is told it is taken', async () => {
  for (const sids of [[OLDER[0], OLDER[1]], [null, null], [null, OLDER[1]], [OLDER[0], null]]) {
    const p = project([{ title: 'a' }, { title: 'b' }]);
    const read = await Promise.all(sids.map((sid) => firstTodo(p.slug, sid)));
    assert.deepEqual(read, [`${p.prefix}-1`, `${p.prefix}-1`]);
    const first = await move(read[0], 'prep', sids[0]);
    const second = await move(read[1], 'prep', sids[1]);
    const name = sids.map((s) => s || 'no session').join(' + ');
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 409, `${name}: the second take was given the task the first one already has`);
    assert.match(second.json().error, new RegExp(`^${p.prefix}-1 is already taken: it is in prep\\. To take a free task: kb take ${p.slug}$`));
    const t = await card(read[0]);
    assert.deepEqual(t.sessions.map((s) => s.session_id), sids[0] ? [sids[0]] : [], `${name}: the refused take was tied to the card`);
    assert.equal(t.events.filter((e) => e.status === 'prep').length, 1);
  }
});

test('an older kb that read To do before the new take moved the task is refused, and kb mv says why', async () => {
  const p = project([{ title: 'a' }, { title: 'b' }]);
  const read = await firstTodo(p.slug, OLDER[0]);
  const took = (await app.inject({ method: 'POST', url: '/api/tasks/take', payload: { project: p.slug }, headers: asSession(SID[0]) })).json();
  assert.equal(took.task.key, read);
  assert.equal((await move(read, 'prep', OLDER[0])).statusCode, 409, 'the older take shares the task the new one took');
  const mv = await run(['mv', read, 'prep']); // a person's terminal: no session at all
  assert.equal(mv.code, 2, 'a refused move must exit 2, like any refusal');
  assert.match(mv.stderr, new RegExp(`^kb: ${p.prefix}-1 is already taken: it is in prep`));
  assert.deepEqual((await card(read)).sessions.map((s) => s.session_id), [SID[0]]);
});

test('the session that holds a task in prep may move it there again; other moves of a task in work are as before', async () => {
  const p = project([{ title: 'a' }, { title: 'b' }]);
  const key = `${p.prefix}-1`;
  assert.equal((await move(key, 'prep', OLDER[0])).statusCode, 200);
  db.prepare("UPDATE task_sessions SET last_seen = '2000-01-01 00:00:00' WHERE session_id = ?").run(OLDER[0]);
  const again = await move(key, 'prep', OLDER[0]);
  assert.equal(again.statusCode, 200, `the session that took the task was refused its own repeat: ${again.body}`);
  const seen = db.prepare('SELECT last_seen FROM task_sessions WHERE session_id = ? AND task_id = ?').get(OLDER[0], again.json().id).last_seen;
  assert.notEqual(seen, '2000-01-01 00:00:00', 'the repeat no longer tells the card the session is still on it');
  assert.equal((await card(key)).events.filter((e) => e.status === 'prep').length, 1);
  // the same session took the task once before (an `ask` task handed back to To do): its tie is old, its
  // move into prep is the last one — the repeat is still its own
  assert.equal((await move(key, 'todo', OLDER[0])).statusCode, 200);
  db.prepare("UPDATE task_sessions SET first_seen = '2000-01-01 00:00:00' WHERE session_id = ?").run(OLDER[0]);
  assert.equal((await move(key, 'prep', OLDER[0])).statusCode, 200);
  assert.equal((await move(key, 'prep', OLDER[0])).statusCode, 200, 'a session that took the task again was refused its own repeat');
  // doing → doing from another session is not a take: it goes through as before
  assert.equal((await move(key, 'doing', OLDER[0])).statusCode, 200);
  assert.equal((await move(key, 'doing', OLDER[1])).statusCode, 200);
  assert.equal((await move(key, 'doing', null)).statusCode, 200);
});

test('a session the board started on a card already in prep may move it there; one tied before that move may not', async () => {
  const { tieLaunched, markBoardSession } = await import('../src/claude-sessions.js');
  const p = project([{ title: 'a' }]);
  const key = `${p.prefix}-1`;
  // an earlier session studied the task and handed it back to To do with questions (an `ask` task)
  assert.equal((await move(key, 'prep', OLDER[0])).statusCode, 200);
  assert.equal((await move(key, 'todo', OLDER[0])).statusCode, 200);
  // the journal keeps whole seconds: the tie is made certainly older than the next move into prep
  db.prepare("UPDATE task_sessions SET first_seen = '2000-01-01 00:00:00' WHERE session_id = ?").run(OLDER[0]);
  assert.equal((await move(key, 'prep', OLDER[1])).statusCode, 200);
  const stale = await move(key, 'prep', OLDER[0]);
  assert.equal(stale.statusCode, 409, 'a session tied to the task before its last move into prep made a second claim on it');
  // the person presses ▶ on the card: the board ties the new Claude to it, and its `kb mv <key> prep` goes through
  const LAUNCHED = 'eeeeeeee-0000-4000-8000-000000000005';
  tieLaunched((await card(key)).id, LAUNCHED);
  markBoardSession(LAUNCHED);
  const resumed = await move(key, 'prep', LAUNCHED);
  assert.equal(resumed.statusCode, 200, `the Claude the board started on this card was refused: ${resumed.body}`);
});
