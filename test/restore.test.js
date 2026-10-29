import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, restore, backupNow, listBackups;

const signalListeners = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
const answers = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/projects`)).ok; } catch { return false; }
};
const waitUntil = async (fn, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  ({ backupNow, listBackups } = await import('../src/backup.js'));
  restore = await import('../src/restore.js');
});

after(() => {
  restore?.stopPreview();
  rmSync(tmp, { recursive: true, force: true });
});

test('importing the module registers no signal handlers', () => {
  assert.equal(signalListeners(), 0);
});

test('a preview board really stops, and its handlers go with it', async () => {
  await backupNow();
  const snapshot = listBackups()[0];
  assert.ok(snapshot, 'a snapshot to feed the restore path');
  const bytes = readFileSync(join(tmp, 'backups', snapshot.name));

  const checked = restore.inspectBackup(bytes);
  assert.equal(checked.ok, true, checked.error);

  const preview = await restore.startPreview(checked.dir, checked.stats);
  assert.ok(preview?.port, 'the preview board reports a port');
  assert.equal(await waitUntil(() => answers(preview.port)), true, 'the preview board answers');
  assert.ok(signalListeners() > 0, 'cleanup is armed while the preview is alive');

  assert.equal(restore.stopPreview(), true);
  assert.equal(await waitUntil(async () => !(await answers(preview.port))), true,
    'the port stops answering — the process is actually gone, not just forgotten');
  assert.equal(signalListeners(), 0, 'cleanup is disarmed together with the preview');
  assert.equal(restore.currentPreview(), null);
});

test('the preview board dies when the parent vanishes without a signal', async () => {
  await backupNow();
  const snapshot = listBackups()[0];
  const bytes = readFileSync(join(tmp, 'backups', snapshot.name));
  const checked = restore.inspectBackup(bytes);
  const preview = await restore.startPreview(checked.dir, checked.stats);
  assert.equal(await waitUntil(() => answers(preview.port)), true, 'the preview board answers');

  const { proc } = restore.previewProcessForTests();
  proc.stdin.end();
  assert.equal(await waitUntil(async () => !(await answers(preview.port))), true,
    'the preview board outlived its parent: it still holds the port and serves a copy of every task');
  restore.stopPreview();
});

test('a backup older than the kv table still opens', async () => {
  const { default: Database } = await import('better-sqlite3');
  const old = join(tmp, 'ancient.db');
  const db = new Database(old);
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT);
           CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT);
           INSERT INTO projects (slug) VALUES ('demo');`);
  db.close();

  const checked = restore.inspectBackup(readFileSync(old));
  assert.equal(checked.ok, true, `an old backup was rejected: ${checked.error}`);
  rmSync(checked.dir, { recursive: true, force: true });
});

test('a backup the board cannot boot from is a refusal, not a green "the board is up"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-restore-'));
  mkdirSync(join(dir, 'kanban.db'));
  await assert.rejects(
    () => restore.startPreview(dir, { tasks: 0, projects: 0, version: 0 }),
    /did not answer/,
    'a board that never came up is reported as running, with a port and statistics',
  );
  assert.equal(restore.currentPreview(), null, 'the failed preview is still counted as the live one');
  assert.equal(existsSync(dir), false, 'a failed start left its copy of the database in /tmp');
});

test('a preview board has a tmux socket of its own: the live board\'s terminals are out of its reach', async () => {
  // out of play — a task accepted in the copy would close the real one, and Stop there would stop it
  const { tmuxSocket } = await import('../src/config.js');
  const env = restore.previewEnv(4000, '/copy');
  assert.ok(env.KB_TMUX_SOCKET, 'the preview inherits the socket of the live board');
  assert.notEqual(env.KB_TMUX_SOCKET, tmuxSocket());
  process.env.KB_TMUX_SOCKET = 'own-socket'; // a board that has a socket of its own set
  try { assert.notEqual(restore.previewEnv(4000, '/copy').KB_TMUX_SOCKET, 'own-socket'); } finally { delete process.env.KB_TMUX_SOCKET; }
  assert.deepEqual([env.PORT, env.KB_DATA_DIR, env.KB_GH_OWNER, env.KB_GH_REPO], ['4000', '/copy', '', '']);
  assert.ok(Number(env.KB_PREVIEW_TTL_MS) > 0);
});

test('stale preview directories are swept on startup', () => {
  const stale = mkdtempSync(join(tmpdir(), 'kb-restore-'));
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  utimesSync(stale, old, old);
  const fresh = mkdtempSync(join(tmpdir(), 'kb-restore-'));

  restore.sweepStalePreviews();
  assert.equal(existsSync(stale), false, 'a stale preview directory was left in /tmp');
  assert.equal(existsSync(fresh), true, 'the sweep took a directory that a live board may be using');
  rmSync(fresh, { recursive: true, force: true });
});

test('a preview board does not inherit what reaches the live board\'s own files', () => {
  const live = { KB_PANEL_INFO: '/live/info.json', PANEL_INFO: '/live/info.json', KB_PANEL_URL: 'http://127.0.0.1:1/',
    PANEL_URL: 'http://127.0.0.1:1/', KB_SKILLS_EXTRA: '/live/skills', pm_id: '7' };
  const saved = Object.fromEntries(Object.keys(live).map((k) => [k, process.env[k]]));
  Object.assign(process.env, live);
  try {
    const env = restore.previewEnv(4000, '/copy');
    for (const k of ['KB_PANEL_INFO', 'PANEL_INFO', 'KB_PANEL_URL', 'PANEL_URL', 'KB_SKILLS_EXTRA']) {
      assert.equal(env[k], '', `${k} of the live board reached the preview board`);
    }
    assert.equal('pm_id' in env, false, 'the preview board passes for a pm2 process');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('a preview board takes no snapshots of its copy — neither daily nor before a migration', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { SCHEMA_VERSION } = await import('../src/db.js');
  const path = await backupNow();
  const old = new Database(path);
  old.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
  old.close();
  const checked = restore.inspectBackup(readFileSync(path));
  assert.equal(checked.ok, true, checked.error);
  const preview = await restore.startPreview(checked.dir, checked.stats);
  try {
    assert.equal(await waitUntil(() => answers(preview.port)), true, 'the preview board answers');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(join(checked.dir, 'backups')), false,
      'the preview board snapshotted its own temporary copy');
  } finally { restore.stopPreview(); }
});

test('a preview board does not update the code it shares with the live board', async () => {
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const bin = mkdtempSync(join(tmp, 'bin-'));
  for (const b of ['git', 'npm']) { writeFileSync(join(bin, b), `#!/bin/sh\necho called >> "${join(bin, 'calls')}"\nexit 1\n`); chmodSync(join(bin, b), 0o755); }
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.KB_PREVIEW_TTL_MS = '60000';
  const app = Fastify();
  await app.register(systemRoutes);
  await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/update' });
    assert.equal(r.statusCode, 403, `the preview board ran an update of the shared code (${r.statusCode})`);
    assert.equal(existsSync(join(bin, 'calls')), false, 'git/npm were called from a preview board');
  } finally {
    delete process.env.KB_PREVIEW_TTL_MS;
    process.env.PATH = savedPath;
    await app.close();
  }
});

test('a preview board gets the attachments without the live board copying them in its own thread', async () => {
  const { ATTACH_MIRROR } = await import('../src/backup.js');
  mkdirSync(join(ATTACH_MIRROR, '77'), { recursive: true });
  writeFileSync(join(ATTACH_MIRROR, '77', '1.png'), 'PNGDATA');
  const path = await backupNow();
  const checked = restore.inspectBackup(readFileSync(path));
  const preview = await restore.startPreview(checked.dir, checked.stats);
  try {
    assert.equal(readFileSync(join(checked.dir, 'attachments', '77', '1.png'), 'utf8'), 'PNGDATA',
      'the preview board has no copy of the attachment');
  } finally { restore.stopPreview(); }
});

test('the attachments are copied while the live board keeps running, not in one blocking step', async () => {
  const { ATTACH_MIRROR } = await import('../src/backup.js');
  const N = 300;
  mkdirSync(join(ATTACH_MIRROR, '88'), { recursive: true });
  for (let i = 0; i < N; i++) writeFileSync(join(ATTACH_MIRROR, '88', `${i}.png`), 'x');
  const path = await backupNow();
  const checked = restore.inspectBackup(readFileSync(path));
  const dest = join(checked.dir, 'attachments', '88');
  const seen = new Set();
  let sampling = true;
  const sample = () => {
    if (!sampling) return;
    seen.add(existsSync(dest) ? readdirSync(dest).length : 0);
    setImmediate(sample);
  };
  setImmediate(sample);
  try {
    await restore.startPreview(checked.dir, checked.stats);
    sampling = false;
    assert.equal(readdirSync(dest).length, N, 'the preview board did not get every attachment');
    assert.ok([...seen].some((n) => n > 0 && n < N),
      `the board only ever saw ${[...seen].join(' or ')} of ${N} files — the copy ran in one blocking step`);
  } finally {
    sampling = false;
    restore.stopPreview();
  }
});
