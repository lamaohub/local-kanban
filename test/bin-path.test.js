// instruction for 10 s and more. Node looks a bare program name up in PATH with one posix_spawn per folder, and the board's
// PATH has six folders before /usr/bin: every `git` was seven processes, and their stream held the start of other
// programs. The board starts its programs by the full path now (src/bin-path.js).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { bin, onPath } from '../src/bin-path.js';

test('bin() gives the full path, found once for a PATH, and a miss is not kept', (t) => {
  const was = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), 'kb-bin-'));
  t.after(() => { process.env.PATH = was; rmSync(dir, { recursive: true, force: true }); });
  const git = bin('git');
  assert.ok(isAbsolute(git), `git is started by its bare name: ${git}`);
  assert.equal(git, onPath('git'));
  // another PATH is another answer: a test that puts a stand-in first gets the stand-in
  writeFileSync(join(dir, 'kb-probe-tool'), '#!/bin/sh\n');
  process.env.PATH = `${join(dir, 'none')}:${was}`;
  assert.equal(bin('kb-probe-tool'), 'kb-probe-tool', 'a program that is not there is its name, as before');
  chmodSync(join(dir, 'kb-probe-tool'), 0o755);
  process.env.PATH = `${dir}:${was}`;
  assert.equal(bin('kb-probe-tool'), join(dir, 'kb-probe-tool'), 'a miss was kept, or the PATH was not looked at');
});

// every program the server starts in its hot paths goes by the full path: a bare name in execFile/spawn is the stream again
test('the server starts no program by a bare name', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const bare = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*'([^'/][^']*)'/g)) bare.push(`${f.split('/src/')[1]}: ${m[1]}`);
  }
  assert.deepEqual(bare, [], 'started by a bare name — use bin() from src/bin-path.js');
});
