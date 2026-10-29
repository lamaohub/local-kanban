/* Claude Code's settings.json — read, and written with the board's two entries (claude-hooks.js decides what changes)
   by both `local-kanban hooks install|uninstall` and Settings → Claude Code on the board.

   The file belongs to the person, so the write is careful: a file that is not valid JSON is never touched; one that
   changed since it was read (Claude Code writes it too, on /permissions or /config) is left alone — writing would lose
   that change; a file the person made read-only is not replaced through its folder; the previous file is copied into
   the board's snapshots first, and nothing is written when that copy cannot be made; the new text goes into a
   temporary file and takes the old one's place in one rename, so a crash never leaves Claude Code half a file. A
   settings.json that is a link (a dotfiles repository) is written where it points, with the mode it had. The text
   keeps the file's own layout (formatLike). */
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { claudeDir, ROOT } from './config.js';
import { snapshotFile } from './file-snapshot.js';
import { formatLike, kbCommand, nodeOnPath } from './claude-hooks.js';

export const settingsFile = () => join(claudeDir(), 'settings.json');

/** How Claude Code is to run this board's kb: by absolute paths — a hook does not get the person's shell PATH
    everywhere (the desktop app's is not the terminal's) — node by the PATH entry that outlives an upgrade, when
    there is one, and the board's address only when it is not the default one. */
export function boardKb(url = '') {
  const node = nodeOnPath({ execPath: process.execPath, PATH: process.env.PATH, realpath: realpathSync, delimiter, exe: process.platform === 'win32' ? 'node.exe' : 'node' });
  const u = String(url || '').replace(/\/+$/, '');
  return kbCommand({ node, kb: join(ROOT, 'bin', 'kb'), url: u && u !== 'http://127.0.0.1:3100' ? u : '' });
}

/** A fingerprint of the file as it was read ('' for no file): the page sends it back with its consent, and a file
    that no longer matches is not written over. */
export const fingerprint = (read) => (read.existed ? createHash('sha256').update(read.text).digest('hex') : '');

/** The file as it is: {path, existed, text, settings} — or the same with `error`: 'unreadable', 'not-json' (with
    `message`) or 'not-object'. */
export function readSettings(path = settingsFile()) {
  if (!existsSync(path)) return { path, existed: false, text: '', settings: {} };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { path, existed: true, text: '', error: 'unreadable', message: e.message }; }
  let settings;
  try { settings = text.trim() ? JSON.parse(text) : {}; } catch (e) { return { path, existed: true, text, error: 'not-json', message: e.message }; }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return { path, existed: true, text, error: 'not-object' };
  return { path, existed: true, text, settings };
}

export function writeProblem(read) {
  try {
    if (read.existed) accessSync(realpathSync(read.path), constants.W_OK);
  } catch { return 'read-only'; }
  try {
    // that is not writable refuses both even when the file itself is writable
    if (read.existed) accessSync(dirname(realpathSync(read.path)), constants.W_OK);
    else {
      let dir = dirname(read.path);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir); // a folder still to be made: its parent decides
      accessSync(dir, constants.W_OK);
    }
    return null;
  } catch { return 'folder'; }
}

export function writeSettings(read, next, { dataDir } = {}) {
  const { path, existed, text } = read;
  let now = null;
  try { now = existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return { error: 'changed' }; }
  if (existed ? now !== text : now !== null) return { error: 'changed' };
  let target;
  try { target = existed ? realpathSync(path) : path; } catch (e) { return { error: 'write', message: e.message }; }
  if (existed) {
    try { accessSync(target, constants.W_OK); } catch { return { error: 'read-only', target }; }
    try { accessSync(dirname(target), constants.W_OK); } catch { return { error: 'folder', target }; }
  }
  let kept = null;
  try { kept = existed ? snapshotFile('claude-settings', 'settings', path, { dataDir }) : null; } catch (e) {
    return { error: 'no-copy', message: e.message };
  }
  const tmp = `${target}.local-kanban-${process.pid}.tmp`;
  try {
    const mode = existed ? statSync(target).mode & 0o777 : null;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, formatLike(text, next), mode === null ? undefined : { mode });
    if (mode !== null) chmodSync(tmp, mode); // the umask may have narrowed it
    renameSync(tmp, target);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* it stays: the message still holds */ }
    return { error: 'write', target, message: e.message };
  }
  return { ok: true, target, kept };
}
