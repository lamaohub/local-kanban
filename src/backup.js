import { cpSync, mkdirSync, existsSync, readdirSync, unlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA_DIR, logError } from './db.js';

const DIR = join(DATA_DIR, 'backups');

const KEEP_DAILY = 7;
const KEEP_MANUAL = 5;
const DAILY_RE = /^kanban-\d{4}-\d{2}-\d{2}\.db$/;
const MANUAL_RE = /^kanban-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/;

function backupFiles(re) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => re.test(f)).sort();
}

function rotate(re, keep) {
  const files = backupFiles(re);
  while (files.length > keep) unlinkSync(join(DIR, files.shift()));
}

let tmpSeq = 0;
let running = null;
async function snapshot(path) {
  while (running) { try { await running; } catch {  } }
  const done = (async () => {
    const tmp = `${path}.${process.pid}.${++tmpSeq}.part`;
    rmSync(tmp, { force: true });
    try {
      await db.backup(tmp);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return path;
  })();
  running = done;
  try { return await done; } finally { if (running === done) running = null; }
}

export const ATTACH_MIRROR = join(DIR, 'attachments');
function mirrorAttachments() {
  const src = join(DATA_DIR, 'attachments');
  if (!existsSync(src)) return;
  cpSync(src, ATTACH_MIRROR, { recursive: true, force: false, errorOnExist: false });
}

export function listBackups() {
  const rows = [
    ...backupFiles(DAILY_RE).map((name) => ({ name, kind: 'daily' })),
    ...backupFiles(MANUAL_RE).map((name) => ({ name, kind: 'manual' })),
  ];
  return rows
    .map(({ name, kind }) => {
      const s = statSync(join(DIR, name));
      return { name, kind, size: s.size, mtime: s.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function backupPath(name) {
  const found = listBackups().find((b) => b.name === name);
  return found ? join(DIR, found.name) : null;
}

export const backupState = { last_ok: null, last_error: null, last_error_at: null };

export async function backupNow() {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `kanban-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
  await snapshot(path);
  mirrorAttachments();
  rotate(MANUAL_RE, KEEP_MANUAL);
  backupState.last_ok = new Date().toISOString();
  return path;
}

const BACKUP_EVERY_MS = 6 * 3600 * 1000;
const BACKUP_RETRY_MS = 10 * 60 * 1000;
export function startBackups() {
  mkdirSync(DIR, { recursive: true });
  let timer = null;
  const again = (ms) => { clearTimeout(timer); timer = setTimeout(run, ms); timer.unref?.(); };
  function run() {
    const path = join(DIR, `kanban-${new Date().toISOString().slice(0, 10)}.db`);
    if (existsSync(path)) {
      mirrorAttachments();
      backupState.last_ok = backupState.last_ok || statSync(path).mtime.toISOString();
      again(BACKUP_EVERY_MS);
      return;
    }
    snapshot(path)
      .then(() => {
        mirrorAttachments();
        rotate(DAILY_RE, KEEP_DAILY);
        backupState.last_ok = new Date().toISOString();
        backupState.last_error = null;
        console.log(`backup: ${path}`);
        again(BACKUP_EVERY_MS);
      })
      .catch((e) => {
        backupState.last_error = e.message;
        backupState.last_error_at = new Date().toISOString();
        logError('server', 'backup', `daily backup failed: ${e.message}`, e.stack);
        console.error('backup failed:', e.message);
        again(BACKUP_RETRY_MS);
      });
  }
  run();
}
