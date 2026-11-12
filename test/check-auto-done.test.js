// are in Done and the ones it sent back are in To do: nothing in it waits for the person's word, and left in Review it stood
// over the tasks they did have to accept (TR-603, TIC-126 — both moved to Done by hand).
// The real routes on a fresh base; `kb review` against a stand-in board for what it prints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

let app, tmp, folder, db, bus;
const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const inject = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });
const add = async (title, labels = []) => {
  const r = await inject('POST', '/api/tasks', { project: 'shop', title, status: 'todo', labels });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};
const patch = (key, body, sid = null) => inject('PATCH', `/api/tasks/${key}`, body, sid ? { 'x-claude-session': sid } : {});
const journal = (id) => db.prepare('SELECT status, session_id FROM task_events WHERE task_id = ? ORDER BY id').all(id);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-check-done-')));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-test-check-done-${process.pid}`; // never the board's own socket
  delete process.env.KB_GH_OWNER; delete process.env.KB_GH_REPO;
  ({ db } = await import('../src/db.js'));
  ({ bus } = await import('../src/bus.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('shop','SH','Shop',1,?)").run(folder);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('a check whose report is left goes on to Done, and the answer says so', async () => {
  const c = await add('Check the tasks in Review', ['check']);
  assert.equal((await patch(c.key, { status: 'prep' }, SID)).statusCode, 200);
  assert.equal((await patch(c.key, { status: 'doing' }, SID)).statusCode, 200);
  const seen = [];
  const listen = (e) => { if (e.type === 'task.updated' && e.data.id === c.id) seen.push([e.data.prev_status, e.data.status]); };
  bus.on('event', listen);
  const r = await patch(c.key, { status: 'review' }, SID);
  bus.off('event', listen);
  // one event, of Done: one of Review first rang the Review sound, the notification and the call for a task in Done
  assert.deepEqual(seen, [['doing', 'done']]);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'done', 'kb review would say "review" of a check the board has closed');
  const row = db.prepare('SELECT status, done_at, work_started_at FROM tasks WHERE id = ?').get(c.id);
  assert.equal(row.status, 'done');
  assert.ok(row.done_at, 'no done_at: the dashboard would not count the check as finished');
  assert.equal(row.work_started_at, null);
  // the journal keeps both: the report, then the close — signed by nobody, it is the board's
  assert.deepEqual(journal(c.id).slice(-2).map((e) => e.status), ['review', 'done']);
  assert.equal(journal(c.id).at(-1).session_id, null);
});

test('straight from prep — a check with nothing to do — the same', async () => {
  const c = await add('Check again', ['check']);
  await patch(c.key, { status: 'prep' }, SID);
  const r = await patch(c.key, { status: 'review' }, SID);
  assert.equal(r.json().status, 'done');
});

test('an ordinary task stays in Review for the person', async () => {
  const t = await add('A plain task');
  await patch(t.key, { status: 'prep' }, SID);
  await patch(t.key, { status: 'doing' }, SID);
  const r = await patch(t.key, { status: 'review' }, SID);
  assert.equal(r.json().status, 'review');
});

test('kb review of a check already closed — a retry, a lost answer — leaves it in Done', async () => {
  const c = await add('A check to retry', ['check']);
  await patch(c.key, { status: 'prep' }, SID);
  await patch(c.key, { status: 'doing' }, SID);
  await patch(c.key, { status: 'review' }, SID);
  const before = journal(c.id).length;
  const r = await patch(c.key, { status: 'review' }, SID);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'done', 'the retry took the check out of Done for good');
  assert.equal(journal(c.id).length, before, 'the retry wrote a move');
});

test('a check the person puts back into Review from Done stays where they put it', async () => {
  const c = await add('One more check', ['check']);
  await patch(c.key, { status: 'prep' });
  await patch(c.key, { status: 'review' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.id).status, 'done');
  const r = await patch(c.key, { status: 'review' });
  assert.equal(r.json().status, 'review', 'the person moved it to Review to read it, and the board took it away again');
});

test('kb review prints where the task is: done for a check the board closed', async () => {
  const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
  let status = 'done';
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'PATCH' ? 200 : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'PATCH'
        ? { id: 9, key: 'SH-9', status, project: 'shop', title: 'check', labels: ['check'], checklist: [], links: [] }
        : { id: 1, author: 'claude', body: 'report' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const run = () => new Promise((resolve) => {
    const e = { ...process.env, KB_URL: `http://127.0.0.1:${server.address().port}` };
    delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID; delete e.KB_DEBUG;
    execFile(process.execPath, [KB, 'review', 'SH-9', 'report'], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  try {
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'SH-9 done 📝');
    status = 'review';
    assert.equal((await run()).stdout.trim(), 'SH-9 review 📝');
  } finally { server.close(); }
});

// it are work again — back to doing, as words to a report in Review were — and its next report closes it again. Left in
// Done, Claude worked unseen and its report was a silent retry.
test('words typed to a check closed on its report take it back to work; its next report closes it; words about another task leave it in Done', async () => {
  const { moveTyped, typedBackWarning } = await import('../src/routes/tasks.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('lab','LB','Lab',1,?)").run(folder);
  const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const mk = async (title, labels = []) => (await inject('POST', '/api/tasks', { project: 'lab', title, status: 'todo', labels })).json();
  const c = await mk('Check the lab', ['check']);
  for (const s of ['prep', 'doing', 'review']) assert.equal((await patch(c.key, { status: s }, S2)).statusCode, 200);
  const status = () => db.prepare('SELECT status FROM tasks WHERE id = ?').get(c.id).status;
  assert.equal(status(), 'done');
  assert.deepEqual(moveTyped({ ...c, labels: JSON.stringify(['check']) }, S2).doing, [c.key], 'words to a check in Done left it there');
  assert.equal(status(), 'doing');
  const w = typedBackWarning(db.prepare("SELECT t.*, p.prefix || '-' || t.task_no AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(c.id), S2);
  assert.match(w?.text || '', /moved it back from done/);
  assert.match(w.text, new RegExp(`kb review ${c.key}`));
  // its next report closes it again, as the first one did
  const r = await patch(c.key, { status: 'review' }, S2);
  assert.equal(r.json().status, 'done', 'the report after the words left the check in Review');
  // words that were about another task: the session takes that one into work, and the check goes back to Done, not Review
  assert.deepEqual(moveTyped({ ...c, labels: JSON.stringify(['check']) }, S2).doing, [c.key]);
  const other = await mk('Another task');
  assert.equal((await patch(other.key, { status: 'prep' }, S2)).statusCode, 200);
  assert.equal(status(), 'done', 'undone words put the check into Review instead of back into Done');
  // a task with no check label in Done is accepted work: words to its old terminal do not reopen it
  const plain = await mk('Plain');
  for (const s of ['prep', 'doing', 'review', 'done']) await patch(plain.key, { status: s }, s === 'done' ? null : S2);
  assert.deepEqual(moveTyped({ ...plain, labels: '[]' }, S2).doing, []);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(plain.id).status, 'done');
});
