#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, args) => {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

const dirty = out('git', ['status', '--porcelain']);
if (dirty === null) { console.error('this is not a git repository — update with npm i -g local-kanban@latest'); process.exit(1); }
if (dirty) {
  console.error('the working tree is not clean — commit or stash your changes first:\n' + dirty);
  process.exit(1);
}

console.log('→ git pull');
if (run('git', ['pull', '--ff-only']).status !== 0) {
  console.error('git pull failed (local history diverged from origin?) — sort it out by hand');
  process.exit(1);
}

console.log('→ npm install');
if (run('npm', ['install', '--no-fund', '--no-audit']).status !== 0) process.exit(1);

const pm2List = out('pm2', ['jlist']);
let restarted = false;
if (pm2List) {
  try {
    const procs = JSON.parse(pm2List.slice(pm2List.indexOf('[')));
    if (procs.some((p) => p.name === 'kanban')) {
      console.log('→ pm2 restart kanban');
      restarted = run('pm2', ['restart', 'kanban']).status === 0;
    }
  } catch {  }
}
console.log(restarted
  ? '✓ the board is updated and restarted'
  : '✓ the code is updated — restart the server (pm2 restart kanban / local-kanban start)');
