// A task whose Claude died stayed in "Doing" with its card saying "session closed" and the time running on, into the
// week on the dashboard too. The live watch (refreshLive, every 3 s) now ends the segment, and the next state of a
// living Claude — or a Claude taking the task again with `kb mv <key> doing` — starts a new one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const S1 = '11111111-1111-4111-8111-111111111111';
let app, tmp, claude, db, live, clock, bus, CAP;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  ({ db, WORK_SEGMENT_MAX_S: CAP } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  live = await import('../src/claude-live.js');
  clock = await import('../src/work-clock.js');
  bus = await import('../src/bus.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','WC','Demo',100)").run();
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

let no = 0;
/** A task in `status` whose clock started `ago` seconds back (null — no clock running). */
function task(status, ago) {
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const n = ++no;
  const id = db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, work_started_at)
    VALUES (?,?,?,?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`).run(pid, n, `t${n}`, status, ago, `-${ago} seconds`).lastInsertRowid;
  return { id: Number(id), key: `WC-${n}` };
}
const row = (id) => db.prepare('SELECT work_seconds, work_started_at, work_truncated FROM tasks WHERE id = ?').get(id);
const reg = (file, data) => writeFileSync(join(claude, 'sessions', file), JSON.stringify(data));
function events() {
  const got = [];
  const on = (e) => { if (e.type === 'task.updated') got.push(e.data?.id ?? e.id); };
  bus.bus.on('event', on);
  return { got, off: () => bus.bus.off('event', on) };
}

test('a closed session stops the clock of its task in work, and the time so far is kept', () => {
  const a = task('doing', 600);
  const b = task('deploy', 300);
  const changed = clock.syncClocks([{ id: a.id, status: 'doing', claude: 'gone' }, { id: b.id, status: 'deploy', claude: 'gone' }]);
  assert.deepEqual(changed.sort(), [a.id, b.id].sort());
  assert.equal(row(a.id).work_started_at, null, 'the clock of a task whose session closed still runs');
  assert.ok(Math.abs(row(a.id).work_seconds - 600) <= 2, `the time so far was lost: ${row(a.id).work_seconds}`);
  assert.equal(row(b.id).work_started_at, null, 'deploy is a working status too');
  // stopped already: nothing more is added on the next look
  assert.deepEqual(clock.syncClocks([{ id: a.id, status: 'doing', claude: 'gone' }]), []);
  assert.ok(Math.abs(row(a.id).work_seconds - 600) <= 2);
});

test('the segment a closed session ends is capped like any other', () => {
  const a = task('doing', CAP + 3600);
  clock.syncClocks([{ id: a.id, status: 'doing', claude: 'gone' }]);
  assert.equal(row(a.id).work_seconds, CAP);
  assert.equal(row(a.id).work_truncated, 1);
});

test('a living Claude back on the task starts its clock again; a running clock is left as it is', () => {
  const a = task('doing', null);
  const b = task('doing', 900);
  const startB = row(b.id).work_started_at;
  for (const claude of ['busy', 'idle', 'waiting', 'background', 'starting']) {
    db.prepare('UPDATE tasks SET work_started_at = NULL WHERE id = ?').run(a.id);
    assert.deepEqual(clock.syncClocks([{ id: a.id, status: 'doing', claude }, { id: b.id, status: 'doing', claude }]), [a.id], claude);
    assert.ok(row(a.id).work_started_at, `${claude}: the clock did not start again`);
    assert.equal(row(b.id).work_started_at, startB, `${claude}: a running clock was restarted`);
  }
});

test('outside the working statuses the clock is not touched', () => {
  const p = task('prep', null);
  const r = task('review', null);
  assert.deepEqual(clock.syncClocks([{ id: p.id, status: 'prep', claude: 'busy' }, { id: r.id, status: 'review', claude: 'gone' }]), []);
  assert.equal(row(p.id).work_started_at, null, 'prep has no clock');
});

test('the card hears of it: every changed clock goes out as task.updated', () => {
  const a = task('doing', 60);
  const ev = events();
  try { clock.syncClocks([{ id: a.id, status: 'doing', claude: 'gone' }]); } finally { ev.off(); }
  assert.deepEqual(ev.got, [a.id]);
});

test('the live watch stops the clock of a task whose session closed, and starts it when the session is back', async () => {
  const a = task('prep', null);
  await app.inject({ method: 'PATCH', url: `/api/tasks/${a.key}`, headers: { 'x-claude-session': S1 }, payload: { status: 'doing' } });
  db.prepare("UPDATE tasks SET work_started_at = datetime('now', '-120 seconds') WHERE id = ?").run(a.id);
  const look = async () => ({ live: [], questions: [], background: [], over: [], limited: [] });
  // no registry entry for S1: its Claude is gone
  await live.refreshLive(() => false, look);
  assert.equal(row(a.id).work_started_at, null, 'refreshLive does not stop the clock of a closed session');
  assert.ok(row(a.id).work_seconds >= 119);
  reg('4242.json', { pid: 4242, sessionId: S1, status: 'busy', statusUpdatedAt: Date.now() });
  await live.refreshLive((pid) => pid === 4242, look);
  assert.ok(row(a.id).work_started_at, 'refreshLive does not start the clock when the Claude is back');
});

test('a Claude taking the stopped task again with kb mv doing starts its clock', async () => {
  const a = task('doing', null);
  const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${a.key}`, payload: { status: 'doing' } });
  assert.equal(res.statusCode, 200);
  assert.ok(row(a.id).work_started_at, 'doing → doing left the stopped clock stopped');
  const b = task('doing', 900);
  const startB = row(b.id).work_started_at;
  await app.inject({ method: 'PATCH', url: `/api/tasks/${b.key}`, payload: { status: 'doing' } });
  assert.equal(row(b.id).work_started_at, startB, 'doing → doing restarted a running clock');
});
