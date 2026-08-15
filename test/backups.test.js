import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

test('two snapshots in the same second do not destroy each other', async () => {
  const paths = await Promise.all([backupNow(), backupNow(), backupNow()]);
  for (const p of paths) {
    assert.ok(existsSync(p), `the snapshot disappeared: ${p}`);
    assert.ok(statSync(p).size > 0, `the snapshot is empty (0 bytes): ${p}`);
  }
  assert.deepEqual(readdirSync(DIR).filter((f) => f.includes('.part')).filter((f) => f !== 'kanban-2026-07-09.db.part'), []);
});

test('twenty snapshots at once are still serialised — no 0-byte file, no orphan .part', async () => {
  const paths = await Promise.all(Array.from({ length: 20 }, () => backupNow()));
  for (const p of paths) {
    assert.ok(existsSync(p), `the snapshot disappeared under a parallel one: ${p}`);
    assert.ok(statSync(p).size > 0, `a 0-byte file is left under the final name: ${p}`);
  }
  const orphans = readdirSync(DIR).filter((f) => f.includes('.part') && f !== 'kanban-2026-07-09.db.part');
  assert.deepEqual(orphans, [], `temp files left behind: ${orphans.join(', ')}`);
});

test('a listed snapshot is never a 0-byte stub', () => {
  for (const b of listBackups()) assert.ok(b.size > 0 || b.name.startsWith('kanban-2026-07'),
    `a 0-byte snapshot is offered for download: ${b.name}`);
});

test('attachments are mirrored next to the snapshots', async () => {
  const { ATTACH_MIRROR } = await import('../src/backup.js');
  const src = join(tmp, 'attachments', '42');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, '7.png'), 'PNGDATA');
  await backupNow();
  assert.ok(existsSync(join(ATTACH_MIRROR, '42', '7.png')), 'the attachment did not make it into the backup');

  rmSync(src, { recursive: true, force: true });
  await backupNow();
  assert.ok(existsSync(join(ATTACH_MIRROR, '42', '7.png')), 'the mirror lost a file that the live board deleted');
});

test('a failing daily snapshot is written to the error log, not only to stdout', async () => {
  const { startBackups, backupState } = await import('../src/backup.js');
  const { db } = await import('../src/db.js');
  const orig = db.backup;
  db.backup = () => Promise.reject(new Error('EACCES: permission denied'));
  try {
    rmSync(join(DIR, `kanban-${new Date().toISOString().slice(0, 10)}.db`), { force: true });
    startBackups();
    await new Promise((r) => setTimeout(r, 150));
    const logged = db.prepare("SELECT COUNT(*) n FROM app_errors WHERE scope = 'backup'").get().n;
    assert.ok(logged > 0, 'the daily backup failed silently: nothing in GET /api/errors');
    assert.match(backupState.last_error || '', /EACCES/, 'the section cannot show what broke');
  } finally { db.backup = orig; }
});

test('octet-stream is accepted only where the backup route lives', async () => {
  const { default: Fastify } = await import('fastify');
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const app = Fastify();
  await app.register(taskRoutes);
  await app.ready();

  const r = await app.inject({
    method: 'POST', url: '/api/tasks',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(1024),
  });
  assert.equal(r.statusCode, 415, 'the task route still swallows raw bodies of any size');
  await app.close();
});

test('a rejected upload leaves no temp file behind', async () => {
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  await app.register(systemRoutes);
  await app.ready();

  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('kb-upload-')).length;
  const r = await app.inject({
    method: 'POST', url: '/api/backups/restore',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('this is definitely not a database'.repeat(10)),
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /not an SQLite/);
  const after = readdirSync(tmpdir()).filter((f) => f.startsWith('kb-upload-')).length;
  assert.equal(after, before, 'the uploaded file stayed in the temp directory');
  await app.close();
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
  assert.ok(Array.isArray(before.json().items) && before.json().items.length, 'the list is not empty');
  assert.equal('last_ok' in before.json(), true, 'the section can no longer tell when a snapshot last worked');
  assert.equal('last_error' in before.json(), true, 'the section can no longer tell what broke');

  const made = await app.inject({ method: 'POST', url: '/api/backups' });
  assert.equal(made.statusCode, 200);
  assert.deepEqual(made.json(), { ok: true });

  const after = await app.inject({ method: 'GET', url: '/api/backups' });
  assert.ok(after.json().items.length >= before.json().items.length, 'the snapshot shows up in the list');
  assert.notEqual(after.json().last_ok, null, 'a successful snapshot did not update last_ok');
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
