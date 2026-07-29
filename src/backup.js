import { mkdirSync, existsSync, readdirSync, unlinkSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA_DIR } from './db.js';

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

async function snapshot(path) {
  const tmp = `${path}.part`;
  rmSync(tmp, { force: true });
  try {
    await db.backup(tmp);
    rmSync(path, { force: true });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
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

export async function backupNow() {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `kanban-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
  await snapshot(path);
  rotate(MANUAL_RE, KEEP_MANUAL);
  return path;
}

export function startBackups() {
  mkdirSync(DIR, { recursive: true });
  const run = () => {
    const path = join(DIR, `kanban-${new Date().toISOString().slice(0, 10)}.db`);
    if (existsSync(path)) return;
    snapshot(path)
      .then(() => {
        rotate(DAILY_RE, KEEP_DAILY);
        console.log(`backup: ${path}`);
      })
      .catch((e) => console.error('backup failed:', e.message));
  };
  run();
  setInterval(run, 6 * 3600 * 1000);
}
