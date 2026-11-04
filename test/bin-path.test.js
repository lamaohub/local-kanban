// instruction for 10 s and more. Node looks a bare program name up in PATH with one posix_spawn per folder, and the board's
// PATH has six folders before /usr/bin: every `git` was seven processes, and their stream held the start of other
// programs. The board starts its programs by the full path now (src/bin-path.js).
// shell line, a name in a variable or in `{cmd: 'git'}`, a promisified call and a space before the bracket all passed,
// and bare names stood in src/ and in the tests. It reads the calls of what a file takes from child_process now.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(dir, 'kb-probe-tool'), '#!/bin/sh\n');
  process.env.PATH = `${dir}:${was}`;
  assert.equal(bin('kb-probe-tool'), 'kb-probe-tool', 'a program that cannot be run is its name, as before');
  chmodSync(join(dir, 'kb-probe-tool'), 0o755);
  assert.equal(bin('kb-probe-tool'), join(dir, 'kb-probe-tool'), 'a miss was kept: a program installed later is never found');
  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'kb-probe-tool'), '#!/bin/sh\n', { mode: 0o755 });
  process.env.PATH = `${other}:${dir}:${was}`;
  assert.equal(bin('kb-probe-tool'), join(other, 'kb-probe-tool'), 'the PATH is not in the key: the stand-in first in PATH is not the one started');
});

/* What a call to child_process starts. The names a file takes from child_process (import, `await import`, `promisify`)
   are followed to their calls; the first argument is read: `bin(…)`, `process.execPath` and a path made by a path
   function are full paths, a string is its first word, a name of the file is read where it is set, anything else must be
   named in ALLOWED with the reason it is a full path. And `cmd: '<name>'` anywhere — a spec someone else starts. */
const CP = /(?:'|")(?:node:)?child_process(?:'|")/;
const PATH_MADE = /^(?:bin|fullPath|fileURLToPath|join|resolve|realpathSync)\(|^new URL\(|^process\.execPath\b/;
export function bareStarts(src, file, allowed = {}) {
  const found = [];
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"])/g)) {
    if (CP.test(m[2])) for (const n of m[1].split(',')) { const [a, b] = n.trim().split(/\s+as\s+/); if (a) names.add((b || a).trim()); }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+import|require)\(\s*(['"][^'"]+['"])\s*\)/g)) {
    if (CP.test(m[2])) for (const n of m[1].split(',')) { const [a, b] = n.trim().split(/\s*:\s*/); if (a) names.add((b || a).trim()); }
  }
  const spaces = [];
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*(['"][^'"]+['"])/g)) if (CP.test(m[2])) spaces.push(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+import|require)\(\s*(['"][^'"]+['"])\s*\)/g)) if (CP.test(m[2])) spaces.push(m[1]);
  const fns = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'];
  const callees = [...names, ...spaces.flatMap((s) => fns.map((f) => `${s}\\s*\\.\\s*${f}`))];
  for (const n of [...names]) for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:util\\.)?promisify\\(\\s*${n}\\s*\\)`, 'g'))) callees.push(m[1]);
  for (const n of [...names]) callees.push(`(?:util\\.)?promisify\\(\\s*${n}\\s*\\)`);
  const firstArg = (at) => {
    let depth = 0; let q = null;
    for (let i = at; i < src.length; i += 1) {
      const c = src[i];
      if (q) { if (c === '\\') i += 1; else if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') q = c;
      else if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) { if (!depth) return src.slice(at, i).trim(); depth -= 1; } else if (c === ',' && !depth) return src.slice(at, i).trim();
    }
    return src.slice(at).trim();
  };
  const judge = (expr, at, seen = new Set()) => {
    if (PATH_MADE.test(expr) || (allowed[file] || []).includes(expr)) return null;
    // a list of full paths to pick from: ['/opt/homebrew/bin/tmux', '/usr/bin/tmux'].find(existsSync)
    if (/^\[/.test(expr)) { const list = expr.slice(0, expr.indexOf(']') + 1); if ([...list.matchAll(/(['"])(.*?)\1/g)].every((q) => q[2].startsWith('/')) && /['"]\//.test(list)) return null; }
    const lit = /^(['"`])([\s\S]*)\1$/.exec(expr);
    if (lit) {
      if (lit[1] === '`' && /^\$\{\s*(?:bin|fileURLToPath|join)\(/.test(lit[2])) return null;
      const word = lit[2].trim().split(/\s+/)[0];
      return word.startsWith('/') || word.startsWith('${') ? null : word;
    }
    if (/^\w+$/.test(expr) && !seen.has(expr)) { // the nearest `const X =` before the call
      const set = [...src.slice(0, at).matchAll(new RegExp(`(?:const|let|var)\\s+${expr}\\s*=\\s*`, 'g'))].pop();
      if (set) { seen.add(expr); return judge(firstArgOf(set.index + set[0].length), set.index, seen); }
    }
    return (allowed[file] || []).includes(expr) ? null : expr;
  };
  // the value a `const X =` is set to, up to the end of its statement
  const firstArgOf = (at) => { const end = src.slice(at).search(/;\s*$|;\n|\n(?=\s*(?:const|let|var|function|export|\}|\/\/))/m); return src.slice(at, end < 0 ? undefined : at + end).trim(); };
  for (const c of callees) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${c}\\s*\\(`, 'g'))) {
      const what = judge(firstArg(m.index + m[0].length), m.index);
      if (what) found.push(`${file}:${src.slice(0, m.index).split('\n').length}: ${what}`);
    }
  }
  // a spec of the board's code that something starts later; the tests hold such specs as expectations and as texts to show
  if (!file.startsWith('test/')) for (const m of src.matchAll(/\bcmd\s*:\s*(['"`])([^'"`/\s$][^'"`\s]*)/g)) found.push(`${file}:${src.slice(0, m.index).split('\n').length}: ${m[2]}`);
  return found;
}

// started by a variable that holds a full path — each with why it does
const ALLOWED = {
  'src/phantom.js': ['cmd'], // run(cmd, …): tmuxBin() — a full path from onPath or TMUX_PLACES
  'src/launch.js': ['spec.cmd'], // launchSpec / commandSpec: bin('open'), bin('osascript'), bin('x-terminal-emulator')
  'src/routes/system.js': ['cmd'], // runUpdate's step: updatePlan gives bin('git'), bin('npm')
  'src/sync/github.js': ['ghBin()'], // KB_GH_BIN, a place gh is installed in, or bin('gh')
  'test/chat-deliver.test.js': ['TMUX'], // the first of the places tmux is installed in, or null (the tests skip)
  'test/claude-hooks.test.js': ['sh'], // each of ['/bin/sh', '/bin/dash', '/bin/bash'] that is there
};

test('the guard catches every way of writing a bare name', () => {
  const head = "import { execFile, execFileSync, exec, execSync, spawn as sp } from 'node:child_process';\nimport { promisify } from 'node:util';\n";
  for (const [line, name] of [
    ["execFile('git', []);", 'git'], ['execFile("ps", []);', 'ps'], ['execFileSync(`git`, []);', 'git'], ["exec('git status');", 'git'],
    ["execSync('npm install');", 'npm'], ["const tool = 'git';\nexecFile(tool, []);", 'git'], ["const spec = { cmd: 'git', args: [] };", 'git'],
    ["promisify(execFile)('git', []);", 'git'], ["const run = promisify(execFile);\nrun('git', []);", 'git'], ["sp ('git', []);", 'git'],
    ["execFile(somewhere(), []);", 'somewhere()'],
  ]) {
    const hits = bareStarts(head + line, 'x.js');
    assert.equal(hits.length, 1, `not caught: ${line} → ${JSON.stringify(hits)}`);
    assert.ok(hits[0].endsWith(`: ${name}`), hits[0]);
  }
  const ns = bareStarts("import * as cp from 'node:child_process';\ncp.execFile('git', []);", 'x.js');
  assert.equal(ns.length, 1, 'a namespace import passed');
  const dyn = bareStarts("const { execFileSync: run } = await import('node:child_process');\nrun('git');", 'x.js');
  assert.equal(dyn.length, 1, 'an await import passed');
  for (const line of ["execFile(bin('git'), []);", "execFile(process.execPath, [KB]);", "const GIT = bin('git');\nexecFileSync(GIT, []);",
    "execFile('/usr/bin/git', []);", "exec(`${bin('git')} status`);", "const re = /x/; re.exec('git');", "db.exec('ALTER TABLE x');"]) {
    assert.deepEqual(bareStarts(head + line, 'x.js'), [], `a full path read as bare: ${line}`);
  }
});

// every program the board and its tests start goes by the full path: a bare name in execFile/spawn is the stream again
test('the server, the CLI and the tests start no program by a bare name', () => {
  const root = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk(join(root, 'src'));
  walk(join(root, 'test'));
  for (const b of ['bin/kb', 'bin/local-kanban']) if (existsSync(join(root, b))) files.push(join(root, b));
  const bare = files.filter((f) => !f.endsWith('test/bin-path.test.js')).flatMap((f) => bareStarts(readFileSync(f, 'utf8'), f.slice(root.length), ALLOWED));
  assert.deepEqual(bare, [], 'started by a bare name — use bin() from src/bin-path.js');
});
