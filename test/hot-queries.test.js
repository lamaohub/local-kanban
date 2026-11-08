// not scan whole tables. On the owner's board (27 000 events, 6 000 tasks) three of them were a third of the
// busy time of the process: a session's moves scanned the event journal, the launches waiting for a session
// scanned it with a correlated subquery, and a task by its key scanned every task (upper(prefix) kept the
// index off). The guard is the query plan itself, plus the answers of the rewritten queries.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db, waitingLaunches, resolveTask, sessionEvents;
const SID = '11111111-2222-4333-8444-555555555555';

before(async () => {
  process.env.KB_DATA_DIR = mkdtempSync(join(tmpdir(), 'kb-hot-'));
  process.env.KB_CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'kb-hot-claude-'));
  ({ db } = await import('../src/db.js'));
  ({ waitingLaunches } = await import('../src/claude-sessions.js'));
  ({ resolveTask } = await import('../src/routes/tasks.js'));
  ({ sessionEvents } = await import('../src/work-feed.js'));
});

const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
/** The plans of the statements `fn` really prepares — a copy of the SQL here would stay green after the code went back. */
function plansOf(fn, args) {
  const seen = [];
  const prepare = db.prepare;
  db.prepare = function (sql) { seen.push(sql); return prepare.call(this, sql); };
  try { fn(); } finally { db.prepare = prepare; }
  return seen.map((sql) => plan(sql, ...args(sql)));
}
const nParams = (sql) => (sql.match(/\?/g) || []).length;

test('a session\'s moves are read through an index, not by scanning the journal', () => {
  const sid = '22222222-2222-4333-8444-555555555555'; // asked for the first time: not answered from memory
  const plans = plansOf(() => sessionEvents(sid), (sql) => Array(nParams(sql)).fill(sid));
  for (const p of plans) assert.doesNotMatch(p, /SCAN (e|task_events)\b/, p);
  assert.ok(plans.some((p) => /USING (COVERING )?INDEX idx_events_session/.test(p)), plans.join('\n'));
});

test('the launches waiting for a session start from the tasks in prep, and answer as before', () => {
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('hot','HQ','hot',5)").run().lastInsertRowid;
  const add = (no, status) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,?)').run(pid, no, `T${no}`, status).lastInsertRowid;
  const ev = (task, status, sid = null, ago = 0) => db.prepare(
    "INSERT INTO task_events (task_id, status, session_id, created_at) VALUES (?,?,?, datetime('now', ?))").run(task, status, sid, `-${ago} minutes`).lastInsertRowid;
  const launch = (eventId) => db.prepare("INSERT INTO task_launches (event_id, via) VALUES (?, 'board')").run(eventId);
  const waiting = add(1, 'prep'); launch(ev(waiting, 'prep', null, 30));                // ▶, nobody took it yet
  const taken = add(2, 'prep'); launch(ev(taken, 'prep', SID, 10));                     // a signed launch
  const reprep = add(3, 'prep'); launch(ev(reprep, 'prep', null, 60)); ev(reprep, 'prep', null, 5); // last prep move is not ▶'s
  const left = add(4, 'doing'); launch(ev(left, 'prep', null, 20)); ev(left, 'doing', SID);       // no longer in prep
  const got = waitingLaunches();
  assert.deepEqual([...got.keys()], [waiting]);
  assert.ok(Math.abs(got.get(waiting) - 0.5) < 0.05, `age ${got.get(waiting)}`);
  const [p] = plansOf(() => waitingLaunches(), () => []);
  assert.doesNotMatch(p, /SCAN (e|l|task_events|task_launches)\b/, p);
  assert.deepEqual(sessionEvents(SID).map((e) => e.task_id), [taken, left]);
});

test('a task by its key: any case, through the index, and the key it had before a move', () => {
  const a = db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('keys','KQ','keys')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('keys2','KR','keys2')").run().lastInsertRowid;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 7, 'moved here', 'todo')").run(b).lastInsertRowid;
  db.prepare('INSERT INTO task_moves (project_id, task_no, task_id) VALUES (?, 3, ?)').run(a, id);
  assert.equal(resolveTask('kr-7')?.id, id);
  assert.equal(resolveTask('KR-7')?.key, 'KR-7');
  assert.equal(resolveTask('kq-3')?.id, id, 'the old key still leads to the task');
  assert.equal(resolveTask('KQ-4'), undefined);
  for (const p of plansOf(() => resolveTask('kq-3'), () => ['kq', 3])) {
    assert.doesNotMatch(p, /SCAN (t|tasks|mv|task_moves)\b/, p);
  }
});

test('a session\'s moves are kept between writes and read again after any write', () => {
  const sid = '99999999-2222-4333-8444-555555555555';
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name) VALUES ('memo','MQ','memo')").run().lastInsertRowid;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'm', 'doing')").run(pid).lastInsertRowid;
  const first = db.prepare("INSERT INTO task_events (task_id, status, session_id) VALUES (?, 'prep', ?)").run(task, sid).lastInsertRowid;
  const a = sessionEvents(sid);
  assert.equal(sessionEvents(sid), a, 'read again with nothing written');
  assert.throws(() => a.push({}), TypeError, 'callers share the answer — it must not be changed by one of them');
  db.prepare("INSERT INTO task_events (task_id, status, session_id) VALUES (?, 'doing', ?)").run(task, sid);
  assert.deepEqual(sessionEvents(sid).map((e) => e.status), ['prep', 'doing'], 'a new move was not seen');
  db.prepare('UPDATE task_events SET session_id = NULL WHERE id = ?').run(first); // undoTyped takes the signature off
  assert.deepEqual(sessionEvents(sid).map((e) => e.status), ['doing'], 'a move whose signature was taken off is still the session\'s');
});
