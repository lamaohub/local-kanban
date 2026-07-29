import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { logError } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIFETIME_MS = 30 * 60 * 1000;
let current = null; // { port, proc, dir, startedAt, timer, stats }

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export function inspectBackup(buf) {
  if (buf.length < 100 || buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
    return { ok: false, error: 'not an SQLite database file' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'kb-restore-'));
  const file = join(dir, 'kanban.db');
  writeFileSync(file, buf);
  try {
    const db = new Database(file, { readonly: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') { db.close(); rmSync(dir, { recursive: true, force: true }); return { ok: false, error: `database is corrupted: ${integrity}` }; }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const need of ['tasks', 'projects']) {
      if (!tables.has(need)) { db.close(); rmSync(dir, { recursive: true, force: true }); return { ok: false, error: `an SQLite database, but not a board: no ${need} table` }; }
    }
    const stats = {
      tasks: db.prepare('SELECT COUNT(*) n FROM tasks').get().n,
      projects: db.prepare('SELECT COUNT(*) n FROM projects').get().n,
      version: db.pragma('user_version', { simple: true }),
    };
    db.close();
    disarmSync(file);
    return { ok: true, dir, stats };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `could not read the database: ${e.message}` };
  }
}

function disarmSync(file) {
  const db = new Database(file);
  try {
    db.prepare("DELETE FROM kv WHERE key IN ('gh.owner','gh.repo')").run();
    db.prepare("INSERT INTO kv(key, value) VALUES('sync.paused','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    db.prepare('DELETE FROM sync_queue').run();
  } catch (e) {
    logError('server', 'restore-preview', `could not disable the sync in the copy: ${e.message}`);
    throw e;
  } finally { db.close(); }
}

export function currentPreview() {
  if (!current) return null;
  const { port, startedAt, stats } = current;
  return { port, url: `http://127.0.0.1:${port}`, started_at: startedAt, stats, expires_in: Math.max(0, LIFETIME_MS - (Date.now() - startedAt)) };
}

const onExit = () => { if (current) stopPreview(); };
const SIGNAL_HANDLERS = { SIGINT: () => { stopPreview(); process.exit(130); },
  SIGTERM: () => { stopPreview(); process.exit(143); } };

function armCleanup() {
  process.on('exit', onExit);
  for (const [sig, fn] of Object.entries(SIGNAL_HANDLERS)) process.on(sig, fn);
}
function disarmCleanup() {
  process.off('exit', onExit);
  for (const [sig, fn] of Object.entries(SIGNAL_HANDLERS)) process.off(sig, fn);
}

export function stopPreview() {
  if (!current) return false;
  const { proc, dir, timer } = current;
  clearTimeout(timer);
  disarmCleanup();
  try { proc.kill('SIGTERM'); } catch {  }
  try { setTimeout(() => { try { proc.kill('SIGKILL'); } catch {  } }, 2000).unref(); } catch {  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {  }
  current = null;
  return true;
}

export async function startPreview(dir, stats) {
  stopPreview();
  const port = await freePort();
  const proc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), KB_DATA_DIR: dir, KB_GH_OWNER: '', KB_GH_REPO: '' },
    stdio: 'ignore',
    detached: false,
  });
  proc.on('exit', (code) => { if (current && current.proc === proc && code) logError('server', 'restore-preview', `the preview board crashed, code ${code}`); });
  const timer = setTimeout(() => stopPreview(), LIFETIME_MS);
  current = { port, proc, dir, startedAt: Date.now(), timer, stats };
  armCleanup();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/projects`); if (r.ok) break; } catch {  }
    await new Promise((r) => setTimeout(r, 250));
  }
  return currentPreview();
}
