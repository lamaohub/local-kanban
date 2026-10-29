import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

// GIT_OPTIONAL_LOCKS=0: `git status` would otherwise take the index lock and break a `git add` Claude runs right then
const git = (path, args) => new Promise((resolve) => {
  execFile('git', ['-C', path, ...args], { encoding: 'buffer', timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (err, out) => resolve(err ? null : out));
});

const UNTRACKED_MAX = 5000; // untracked files whose state the print takes; more — no print

/** A fingerprint of the working tree of the project at `path` — its commit, its files' state and their changes — or
    null: not a git repository, or git did not answer. Two equal prints: nothing was committed or changed between them. */
export async function treePrint(path) {
  if (!path) return null;
  // all three at once, at the moment of the call: one after another, a commit made meanwhile split the print in two
  const [status, head, diff, top] = await Promise.all([
    git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(path, ['rev-parse', '--verify', '-q', 'HEAD']), // none in a repository without commits
    git(path, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--binary']),
    git(path, ['rev-parse', '--show-toplevel']), // porcelain paths are the repository's: a project may be a folder in it
  ]);
  if (!status || (head && !diff)) return null;
  // Claude made for the task and edits again would read as a turn of no work. Its size and time of change say it.
  const untracked = status.toString('utf8').split('\0').filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
  if (untracked.length > UNTRACKED_MAX || !top) return null; // too many to look at, or no root to find them: cannot tell
  const root = top.toString('utf8').trim();
  const stamps = await Promise.all(untracked.map((f) => stat(join(root, f)).then((s) => `${f}\0${s.size}\0${s.mtimeMs}`, () => `${f}\0-`)));
  return createHash('sha1').update(head || '').update('\0').update(status).update('\0').update(diff || '').update('\0')
    .update(stamps.join('\0')).digest('hex');
}
