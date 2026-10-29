
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { ZONED, stampTime, zonedStamp } from './stamp.js';

const KEEP = 10;

/** The folder of the snapshots of one kind of file: `<data folder>/backups/<kind>`. `dataDir` is the data folder of a
    board other than this process's own — the setup wizard asks for one before that board has ever run. */
export const snapshotDir = (kind, dataDir = DATA_DIR) => join(dataDir || DATA_DIR, 'backups', kind);

const safeLabel = (label) => String(label).replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, (m) => '_'.repeat(m.length));
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXT_RE = /^\.[A-Za-z0-9]{1,10}$/;
const extOf = (path) => (EXT_RE.test(extname(path)) ? extname(path) : '');

let seq = 0;

export function snapshotFile(kind, label, path, { dataDir } = {}) {
  if (!existsSync(path)) return null;
  const dir = snapshotDir(kind, dataDir);
  mkdirSync(dir, { recursive: true });
  const safe = safeLabel(label);
  const ext = extOf(path);
  let dest;
  for (;;) {
    dest = join(dir, `${safe}-${zonedStamp(new Date(), true)}-${++seq}${ext}`);
    try { copyFileSync(path, dest, constants.COPYFILE_EXCL); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const own = new RegExp(String.raw`^${reEscape(safe)}-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?|${ZONED})(?:-(\d+))?(?:\.[A-Za-z0-9]{1,10})?$`);
  const mine = readdirSync(dir).map((f) => [f, own.exec(f)]).filter(([, m]) => m)
    .map(([f, m]) => ({ f, at: stampTime(m[1]), n: Number(m[2] || 0) }))
    .sort((a, b) => a.at - b.at || a.n - b.n);
  const fresh = basename(dest);
  for (const { f } of mine.slice(0, Math.max(0, mine.length - KEEP))) {
    if (f === fresh) continue;
    try { rmSync(join(dir, f), { force: true }); } catch {  }
  }
  return dest;
}
