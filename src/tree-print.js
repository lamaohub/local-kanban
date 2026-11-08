import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bin } from './bin-path.js';

// GIT_OPTIONAL_LOCKS=0: `git status` would otherwise take the index lock and break a `git add` Claude runs right then
const git = (path, args) => new Promise((resolve) => {
  execFile(bin('git'), ['-C', path, ...args], { encoding: 'buffer', timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (err, out) => resolve(err ? null : out));
});

const UNTRACKED_MAX = 5000; // untracked files whose state the print takes; more — no print

const HERE = ['--', '.'];

/** A fingerprint of the working tree of the project at `path` — its commit, its files' state and their changes under
    `path` — or null: not a git repository, or git did not answer. Two equal prints: nothing was committed, and nothing
    under `path` changed between them. */
export async function treePrint(path) {
  if (!path) return null;
  // all three at once, at the moment of the call: one after another, a commit made meanwhile split the print in two
  const [status, head, diff, top] = await Promise.all([
    git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...HERE]),
    git(path, ['rev-parse', '--verify', '-q', 'HEAD']), // none in a repository without commits
    git(path, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary', ...HERE]),
    git(path, ['rev-parse', '--show-toplevel']), // porcelain paths are the repository's: a project may be a folder in it
  ]);
  if (!status || (head && !diff)) return null;
  // Claude made for the task and edits again would read as a turn of no work. Its size and time of change say it.
  const untracked = status.toString('utf8').split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
  if (untracked.length > UNTRACKED_MAX || !top) return null; // too many to look at, or no root to find them: cannot tell
  const root = top.toString('utf8').trim();
  const stamps = await Promise.all(untracked.map((f) => stat(join(root, f)).then((s) => `${f}\0${s.size}\0${s.mtimeMs}`, () => `${f}\0-`)));
  const rest = createHash('sha1').update(status).update('\0').update(diff || '').update('\0').update(stamps.join('\0')).digest('hex');
  return `${head ? head.toString('utf8').trim() : ''}:${rest}`;
}

export async function turnCommits(path, before, now, format) {
  const cut = (p) => { const i = String(p || '').indexOf(':'); return i > 0 ? [p.slice(0, i), p.slice(i + 1)] : [null, null]; };
  const [a, restA] = cut(before);
  const [b, restB] = cut(now);
  if (!a || !b || a === b || restA !== restB) return null;
  // a pathspec drops a commit that changes nothing (an empty one): at the root of its repository the project is all of it
  const prefix = await git(path, ['rev-parse', '--show-prefix']);
  if (prefix === null) return null;
  if (await git(path, ['merge-base', '--is-ancestor', a, b]) === null) {
    if (!prefix.toString('utf8').trim()) return null;
    return await git(path, ['diff', '--quiet', a, b, ...HERE]) === null ? null : '';
  }
  const out = await git(path, ['log', `--format=${format}`, `${a}..${b}`, ...(prefix.toString('utf8').trim() ? HERE : [])]);
  return out === null ? null : out.toString('utf8');
}
