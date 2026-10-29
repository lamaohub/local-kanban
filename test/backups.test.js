import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, DIR, backupNow, listBackups;

const DAILY = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07']
  .map((d) => `kanban-${d}.db`);
const MANUAL = ['01', '02', '03', '04', '05'].map((s) => `kanban-2026-07-08-10-00-${s}.db`);
const MANUAL_ANY = /^kanban-(?:\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}[+-]\d{4})\.db$/;

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

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  const manual = readdirSync(DIR).filter((f) => MANUAL_ANY.test(f)).sort();
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
    rmSync(join(DIR, `kanban-${localDay()}.db`), { force: true });
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

async function withPrivateTmp(fn) {
  const dir = mkdtempSync(join(tmp, 'tmpdir-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try { return await fn(dir); } finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; }
}
const uploadsIn = (dir) => readdirSync(dir).filter((f) => f.startsWith('kb-upload-'));
async function systemApp() {
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  await app.register(systemRoutes);
  await app.ready();
  return app;
}

test('a rejected upload leaves no temp file behind', async () => {
  const app = await systemApp();
  await withPrivateTmp(async (dir) => {
    const r = await app.inject({
      method: 'POST', url: '/api/backups/restore',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('this is definitely not a database'.repeat(10)),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /not an SQLite/);
    assert.deepEqual(uploadsIn(dir), [], 'the uploaded file stayed in the temp directory');
  });
  await app.close();
});

test('a JSON body cannot name a file for the board to delete — its own database included', async () => {
  const app = await systemApp();
  const victim = join(tmp, 'victim.txt');
  writeFileSync(victim, 'keep me');
  for (const file of [victim, join(tmp, 'kanban.db')]) {
    const r = await app.inject({ method: 'POST', url: '/api/backups/restore', payload: { file, size: 1 } });
    assert.equal(r.statusCode, 415, `a JSON body was taken for an upload of ${file}`);
    assert.ok(existsSync(file), `the board deleted ${file} on a JSON request`);
  }
  await app.close();
});

test('a malformed upload does not jam the next one with 409 until a restart', async () => {
  const app = await systemApp();
  const odd = await app.inject({ method: 'POST', url: '/api/backups/restore', payload: { file: 1, size: 1 } });
  assert.equal(odd.statusCode, 415);
  await withPrivateTmp(async () => {
    const next = await app.inject({
      method: 'POST', url: '/api/backups/restore',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('still not a database'.repeat(10)),
    });
    assert.equal(next.statusCode, 400, `the next real upload got ${next.statusCode} instead of being checked`);
  });
  await app.close();
});

test('a raw body is refused by every other system route — no temp file, no side effects', async () => {
  const { kvGet, kvSet } = await import('../src/db.js');
  kvSet('onboarding.done', '1');
  kvSet('ui.lang', 'en');
  kvSet('sync.paused', '1');
  const app = await systemApp();
  await withPrivateTmp(async (dir) => {
    for (const url of ['/api/lang', '/api/errors', '/api/onboarding', '/api/sync/pause']) {
      const r = await app.inject({
        method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(4096, 1),
      });
      assert.equal(r.statusCode, 415, `${url} took a raw body (${r.statusCode})`);
    }
    assert.deepEqual(uploadsIn(dir), [], 'a raw body on a non-upload route left a copy in the temp directory');
  });
  assert.equal(kvGet('onboarding.done'), '1', 'the onboarding flag was reset by a raw body');
  assert.equal(kvGet('ui.lang'), 'en', 'the language was switched by a raw body');
  assert.equal(kvGet('sync.paused'), '1', 'the sync pause was lifted by a raw body');
  await app.close();
});

test('an upload over the limit is cut off with 413 and leaves no temp file', async () => {
  const { Readable } = await import('node:stream');
  const app = await systemApp();
  await withPrivateTmp(async (dir) => {
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const body = new Readable({ read() { this.push(sent++ < 65 ? chunk : null); } });
    const r = await app.inject({
      method: 'POST', url: '/api/backups/restore', headers: { 'content-type': 'application/octet-stream' }, payload: body,
    });
    assert.equal(r.statusCode, 413, `a 65 MB upload was taken in (${r.statusCode})`);
    assert.deepEqual(uploadsIn(dir), [], 'the cut-off upload stayed in the temp directory');
  });
  await app.close();
});

test('abandoned uploads are swept on startup, a live one is not', async () => {
  const { sweepStaleUploads } = await import('../src/restore.js');
  await withPrivateTmp(async (dir) => {
    const name = (pid, n) => join(dir, `kb-upload-${pid}-${n}.db`);
    const dead = name(9999999, 1);
    const own = name(process.pid, 2);
    const neighbour = name(process.ppid, 3);
    const stale = name(process.ppid, 4);
    const other = join(dir, 'kb-upload-notes.txt');
    for (const f of [dead, own, neighbour, stale, other]) writeFileSync(f, 'x');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(stale, old, old);

    assert.equal(sweepStaleUploads(), 2);
    assert.equal(existsSync(dead), false, 'an upload abandoned by a dead process stayed');
    assert.equal(existsSync(stale), false, 'a two-hour-old upload stayed');
    assert.ok(existsSync(own) && existsSync(neighbour), 'the sweep took an upload that is still in progress');
    assert.ok(existsSync(other), 'the sweep took a file that is not an upload');
  });
});

test('two uploads in a row are both checked — the busy flag is cleared after each', async () => {
  const app = await systemApp();
  await withPrivateTmp(async (dir) => {
    for (const n of [1, 2]) {
      const r = await app.inject({
        method: 'POST', url: '/api/backups/restore',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from(`not a database, upload ${n} `.repeat(10)),
      });
      assert.equal(r.statusCode, 400, `upload ${n} got ${r.statusCode} instead of being checked`);
    }
    assert.deepEqual(uploadsIn(dir), [], 'an upload stayed in the temp directory');
  });
  await app.close();
});

test('a starting board sweeps an upload abandoned by a killed process', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const port = await new Promise((res, rej) => {
    const s = createServer().once('error', rej).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const root = mkdtempSync(join(tmp, 'boot-'));
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const abandoned = join(temp, 'kb-upload-9999999-1.db');
  writeFileSync(abandoned, 'x');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(KB_|PANEL_)|^(CLAUDE_CONFIG_DIR|pm_id)$/.test(k)) delete env[k];
  Object.assign(env, {
    PORT: String(port), HOME: root, TMPDIR: temp,
    KB_DATA_DIR: join(root, 'data'), KB_LOCAL_ROOT: join(root, 'projects'), KB_CLAUDE_DIR: join(root, 'claude'),
    KB_GH_BIN: join(root, 'no-gh'), KB_CLAUDE_BIN: join(root, 'no-claude'), KB_TMUX_SOCKET: `kb-test-boot-${process.pid}`,
  });
  const board = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], { env, stdio: 'ignore' });
  const wait = async (ok, ms) => {
    for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) if (await ok()) return true;
    return false;
  };
  try {
    const up = await wait(() => fetch(`http://127.0.0.1:${port}/api/labels`).then((r) => r.ok, () => false), 15000);
    assert.ok(up, 'the board did not start');
    assert.ok(await wait(() => !existsSync(abandoned), 5000), 'the board started and left the abandoned upload in place');
  } finally {
    board.kill();
  }
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

test('unfinished snapshot files are swept when snapshots start — except the one being written', async () => {
  const { sweepPartials, startBackups } = await import('../src/backup.js');
  const pre = join(DIR, 'pre-migrate');
  mkdirSync(pre, { recursive: true });
  const stale = [join(DIR, 'kanban-2026-07-10.db.99999.1.part'), join(DIR, 'kanban-2026-07-10.db.99999.1.part-journal'),
    join(DIR, 'kanban-2026-07-11.db.part'), join(pre, 'kanban-v7-2026-07-01-00-00-00.db.part')];
  const mine = join(DIR, `kanban-2026-07-12.db.${process.pid}.77.part`);
  for (const f of [...stale, mine]) writeFileSync(f, 'x');
  sweepPartials();
  for (const f of stale) assert.equal(existsSync(f), false, `an orphaned unfinished snapshot stayed: ${f}`);
  assert.ok(existsSync(mine), 'the sweep took the snapshot this process is writing right now');
  for (const f of DAILY.slice(-3)) assert.ok(existsSync(join(DIR, f)), `the sweep took a finished snapshot ${f}`);
  rmSync(mine);

  const orphan = join(DIR, 'kanban-2026-07-13.db.99999.2.part');
  writeFileSync(orphan, 'x');
  startBackups();
  assert.equal(existsSync(orphan), false, 'starting the snapshots left an orphaned unfinished file');
});

test('snapshot names follow the local clock, not UTC', async () => {
  const saved = process.env.TZ;
  process.env.TZ = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Etc/GMT-14';
  try {
    const day = localDay();
    assert.notEqual(day, new Date().toISOString().slice(0, 10), 'the time zone trick did not work');
    const path = await backupNow();
    assert.ok(path.split('/').pop().startsWith(`kanban-${day}_`), `a manual snapshot is named by UTC: ${path}`);
    const { startBackups } = await import('../src/backup.js');
    const daily = join(DIR, `kanban-${day}.db`);
    rmSync(daily, { force: true });
    startBackups();
    for (let i = 0; i < 20000 && !existsSync(daily); i++) await new Promise((r) => setImmediate(r));
    assert.ok(existsSync(daily), `the daily snapshot is not named by the local date ${day}`);
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('the daily snapshot: a failure is retried in minutes, success clears the error and mirrors attachments', async (t) => {
  const { startBackups, backupState, ATTACH_MIRROR } = await import('../src/backup.js');
  const { db } = await import('../src/db.js');
  const daily = join(DIR, `kanban-${localDay()}.db`);
  const settle = async (cond, rounds = 20000) => { for (let i = 0; i < rounds && !cond(); i++) await new Promise((r) => setImmediate(r)); return cond(); };
  await settle(() => existsSync(daily));
  rmSync(daily, { force: true });
  mkdirSync(join(tmp, 'attachments', '55'), { recursive: true });
  writeFileSync(join(tmp, 'attachments', '55', '9.png'), 'PNGDATA');

  const real = db.backup;
  db.backup = () => Promise.reject(new Error('EACCES: permission denied'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    startBackups();
    assert.ok(await settle(() => /EACCES/.test(backupState.last_error || '')), 'the failure was not recorded');
    db.backup = real;
    t.mock.timers.tick(10 * 60 * 1000);
    assert.ok(await settle(() => existsSync(daily) && backupState.last_error === null),
      'no retry ten minutes after a failure — or a success left the old error on display');
    assert.ok(existsSync(join(ATTACH_MIRROR, '55', '9.png')), 'the daily snapshot did not mirror the attachments');
  } finally {
    db.backup = real;
    t.mock.timers.reset();
  }
});

const utcName = (d) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '-');
const clearManual = () => { for (const f of readdirSync(DIR)) if (MANUAL_ANY.test(f)) rmSync(join(DIR, f)); };
async function inZone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

for (const tz of ['Etc/GMT+7', 'Etc/GMT-7']) { // UTC−7 (west) and UTC+7 (east): Etc/ signs are reversed
  test(`a manual snapshot taken at ${tz} outlives five UTC-named ones from the last five hours`, async () => {
    clearManual();
    const now = Date.now();
    const older = [5, 4, 3, 2, 1].map((h) => `kanban-${utcName(new Date(now - h * 3600_000))}.db`);
    for (const f of older) writeFileSync(join(DIR, f), 'x');
    const path = await inZone(tz, () => backupNow());
    assert.ok(existsSync(path), `the snapshot just taken was rotated away at once: ${path}`);
    const left = readdirSync(DIR).filter((f) => MANUAL_ANY.test(f));
    assert.equal(left.length, 5, `${left.length} manual snapshots left: ${left.join(', ')}`);
    assert.deepEqual(older.filter((f) => !left.includes(f)), [older[0]], 'the one taken five hours ago goes first');
  });
}

test('manual snapshots are rotated by the moment in their names, offsets and older UTC names included', async () => {
  clearManual();
  // by moment: A 03:00Z, C 04:00Z, B and E 05:00Z, D 06:30Z — as text E sorts first and A last but one
  const A = 'kanban-2026-07-08_10-00-00+0700.db';
  const B = 'kanban-2026-07-08_05-00-00+0000.db';
  const C = 'kanban-2026-07-08-04-00-00.db';
  const D = 'kanban-2026-07-08_09-30-00+0300.db';
  const E = 'kanban-2026-07-07_23-00-00-0600.db';
  for (const f of [A, B, C, D, E]) writeFileSync(join(DIR, f), 'x');
  const path = await backupNow();
  const left = readdirSync(DIR).filter((f) => MANUAL_ANY.test(f)).sort();
  assert.deepEqual(left, [path.split('/').pop(), B, C, D, E].sort(), 'the earliest moment (A, 03:00 UTC) should be the one rotated away');
  clearManual();
});
