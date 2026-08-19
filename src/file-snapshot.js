
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const KEEP = 10;

export const snapshotDir = (kind) => join(DATA_DIR, 'backups', kind);

export function snapshotFile(kind, label, path) {
  if (!existsSync(path)) return null;
  const dir = snapshotDir(kind);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(dir, `${label}-${stamp}.md`);
  copyFileSync(path, dest);
  const mine = readdirSync(dir).filter((f) => f.startsWith(`${label}-`) && f.endsWith('.md')).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
    try { rmSync(join(dir, old), { force: true }); } catch {  }
  }
  return dest;
}
