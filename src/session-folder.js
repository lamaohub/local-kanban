import { closeSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { bin } from './bin-path.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024; // the first lines carry the cwd; the transcript itself can be hundreds of MB

/** The folder the session was STARTED in (the first cwd of its transcript; attempts.js `sessionFolder` is the last one,
    where it works now); null when it cannot be told. */
export function startFolder(sessionId, claudeDir) {
  if (!ID_RE.test(String(sessionId || '')) || !claudeDir) return null;
  let dirs;
  try { dirs = readdirSync(join(claudeDir, 'projects')); } catch { return null; }
  for (const d of dirs) {
    const file = join(claudeDir, 'projects', d, `${sessionId}.jsonl`);
    let fd;
    try { fd = openSync(file, 'r'); } catch { continue; }
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      const lines = buf.subarray(0, n).toString('utf8').split('\n');
      if (n === HEAD_BYTES) lines.pop(); // the last one may be cut
      for (const line of lines) {
        if (!line.includes('"cwd"')) continue;
        try { const cwd = JSON.parse(line).cwd; if (typeof cwd === 'string' && cwd) return cwd; } catch { /* a line half-written */ }
      }
      return null;
    } catch { return null; } finally { closeSync(fd); }
  }
  return null;
}

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
// the repository a folder belongs to, by its common git dir: every worktree of one repository shares it
function repoOf(dir) {
  try {
    return real(execFileSync(bin('git'), ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim());
  } catch { return null; }
}

/** Whether a session in `cwd` is outside the project at `path`: not in its folder, and not in another copy (a git
    worktree) of its repository — a project inside a monorepo is at home in any copy of that monorepo. Unknown — false. */
export function foreignFolder(cwd, path) {
  const c = cwd && real(cwd);
  const p = path && real(path);
  if (!c || !p) return false;
  if (inside(c, p)) return false;
  const rp = repoOf(p);
  return !(rp && rp === repoOf(c));
}

/** The words kb says about such a session. */
export const folderWarning = (cwd, slug, path) =>
  `this session was opened in ${cwd}, outside the folder of ${slug}: the project's instructions (CLAUDE.md, .claude/rules, its memory) are not loaded — open the session in ${path}, or read its CLAUDE.md before the work`;
