import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, DIR, backupNow, listBackups;

const DAILY = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07']
  .map((d) => `kanban-${d}.db`);
const MANUAL = ['01', '02', '03', '04', '05'].map((s) => `kanban-2026-07-08-10-00-${s}.db`);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  ({ backupNow, listBackups } = await import('../src/backup.js'));
  DIR = join(tmp, 'backups');
  mkdirSync(DIR, { recursive: true });
  for (const f of [...DAILY, ...MANUAL]) writeFileSync(join(DIR, f), 'x');
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('backups live next to the database (KB_DATA_DIR), not next to the code', async () => {
  const path = await backupNow();
  assert.ok(path.startsWith(tmp), `the backup landed outside KB_DATA_DIR: ${path}`);
  assert.ok(existsSync(path));
});

test('a manual snapshot leaves the daily history alone — all 7 dailies survive', () => {
  const left = readdirSync(DIR);
  for (const f of DAILY) assert.ok(left.includes(f), `daily backup ${f} was overwritten by a manual snapshot`);
});

test('manual snapshots rotate on their own — the oldest goes first', () => {
  const manual = readdirSync(DIR).filter((f) => /^kanban-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort();
  assert.ok(manual.length <= 5, `${manual.length} manual snapshots, expected at most 5`);
  assert.ok(!manual.includes(MANUAL[0]), 'the oldest manual snapshot should be gone');
});

test('an unfinished snapshot (*.part) appears in neither the list nor the rotation', () => {
  writeFileSync(join(DIR, 'kanban-2026-07-09.db.part'), 'truncated');
  const names = listBackups().map((b) => b.name);
  assert.ok(!names.some((n) => n.endsWith('.part')), '.part leaked into the backup list');
});

test('the list returns both daily and manual snapshots, newest first', () => {
  const list = listBackups();
  assert.ok(list.some((b) => b.kind === 'daily'), 'no dailies in the list');
  assert.ok(list.some((b) => b.kind === 'manual'), 'no manual snapshots in the list');
  const times = list.map((b) => b.mtime);
  assert.deepEqual(times, [...times].sort().reverse(), 'the list is not sorted newest first');
});

test('GET /api/backups lists them, POST takes a new one', async () => {
  const { default: Fastify } = await import('fastify');
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  await app.register(taskRoutes);
  await app.register(systemRoutes);
  await app.ready();

  const before = await app.inject({ method: 'GET', url: '/api/backups' });
  assert.equal(before.statusCode, 200);
  assert.ok(Array.isArray(before.json()) && before.json().length, 'the list is not empty');

  const made = await app.inject({ method: 'POST', url: '/api/backups' });
  assert.equal(made.statusCode, 200);
  assert.deepEqual(made.json(), { ok: true });

  const after = await app.inject({ method: 'GET', url: '/api/backups' });
  assert.ok(after.json().length >= before.json().length, 'the snapshot shows up in the list');
  await app.close();
});

test('GET /api/backups/:name serves a file, but only one from the snapshot list', async () => {
  const { default: Fastify } = await import('fastify');
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  await app.register(taskRoutes);
  await app.register(systemRoutes);
  await app.ready();

  const name = listBackups()[0].name;
  const ok = await app.inject({ method: 'GET', url: `/api/backups/${encodeURIComponent(name)}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.match(ok.headers['content-disposition'], /attachment; filename="/);
  assert.ok(ok.rawPayload.length > 0, 'the body is not empty');

  for (const bad of ['../kanban.db', '..%2F..%2Fkanban.db', 'kanban.db', 'no-such.db', `${name}.part`]) {
    const r = await app.inject({ method: 'GET', url: `/api/backups/${encodeURIComponent(bad)}` });
    assert.equal(r.statusCode, 404, `\\'${bad}\\' must return 404, not a file`);
  }
  await app.close();
});
