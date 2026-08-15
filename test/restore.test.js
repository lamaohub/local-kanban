import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, utimesSync } from 'node:fs';
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
