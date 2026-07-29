import { execFile } from 'node:child_process';

const cache = new Map();
const TTL = 5 * 60 * 1000;

const gitOut = (args) => new Promise((resolve) =>
  execFile('git', args, { timeout: 3000 }, (err, out) => resolve(err ? null : String(out).trim())));

export function forgetRepoBase(path) {
  if (path) cache.delete(path);
}

export async function repoHttpsBase(path) {
  if (!path) return null;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.base;
  const url = await gitOut(['-C', path, 'remote', 'get-url', 'origin']);
  // git@github.com:owner/repo.git | https://github.com/owner/repo
  const m = url?.match(/github\.com[:/](.+?)(?:\.git)?$/);
  const base = m ? `https://github.com/${m[1]}` : null;
  cache.set(path, { base, at: Date.now() });
  return base;
}
