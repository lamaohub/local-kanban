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

const CP_MOD = String.raw`['"\`](?:node:)?child_process['"\`]`;
const FNS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// what the shell runs itself, and the words after which the next word is a program again
const SH_OK = new Set(('. : [ [[ ]] alias bg break builtin cd command continue echo eval exec exit export false fg getopts '
  + 'hash jobs kill let local printf pwd read readonly return set shift source test times trap true type typeset ulimit '
  + 'umask unalias unset wait if then else elif fi do done case esac for while until select function in time ! { }').split(' '));
const SH_THEN = new Set(['!', 'then', 'else', 'elif', 'do', 'if', 'while', 'until', '{']);
// a program that starts the program named in its arguments: the first argument that is no option, VAR=value or duration
const SH_WRAP = new Set(['exec', 'command', 'builtin', 'time', 'nohup', 'env', 'nice', 'sudo', 'xargs', 'timeout', 'caffeinate', 'stdbuf']);
const WRAP_PROG = new RegExp(String.raw`(?:^|[/'"\`(])(?:${[...SH_WRAP].join('|')})['"\`]`);
const SHELL_PROG = /(?:^|[/'"`(\s])(?:ba|z|da|k|fi)?sh(?:['"`)\s]|$)|SHELL|(?<![\w$])shells?(?![\w$])/;

/** The words of a shell line that stand where the shell starts a program: [{ text, dyn }], `dyn` when the word starts
    with an expansion (`$x`, `"$@"`, `$(…)`) — its value is not in the line. `$(…)` and backquotes are read inside. */
export function shellCommands(line, first = true) {
  const out = [];
  let word = ''; let dyn = false; let has = false; let cmd = first; let wrap = false; let redirect = false;
  const end = () => {
    if (!has) return;
    const w = word; const d = dyn;
    word = ''; dyn = false; has = false;
    if (redirect) { redirect = false; return; } // the file after `>` / `2>`
    if (/^\d*(?:[<>]+&?|&>)$/.test(w)) { redirect = true; return; }
    if (/^\d*[<>]/.test(w) || !cmd) return;
    if (!d && /^[A-Za-z_]\w*=/.test(w)) return; // VAR=value before the program
    if (wrap && !d && (/^-/.test(w) || /^\d+(?:\.\d+)?[smhd]?$/.test(w))) return;
    wrap = false;
    out.push({ text: w, dyn: d });
    if (SH_WRAP.has(w.replace(/^.*\//, ''))) { wrap = true; return; }
    if (!SH_THEN.has(w)) cmd = false;
  };
  const closeParen = (j) => {
    let depth = 0;
    for (let k = j; k < line.length; k += 1) {
      const ch = line[k];
      if (ch === '\\') k += 1;
      else if (ch === '\'') { const e = line.indexOf('\'', k + 1); k = e < 0 ? line.length : e; } else if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (!depth) return k; }
    }
    return line.length;
  };
  // `$(…)`, `$((…))` or a backquote at `j`: the programs inside; returns where it ends
  const inner = (j) => {
    if (line[j] === '`') {
      let k = j + 1;
      for (; k < line.length && line[k] !== '`'; k += 1) if (line[k] === '\\') k += 1;
      out.push(...shellCommands(line.slice(j + 1, k)));
      return k;
    }
    const k = closeParen(j + 1);
    if (line[j + 2] !== '(') out.push(...shellCommands(line.slice(j + 2, k)));
    return k;
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\') { if (line[i + 1] !== '\n') { word += line[i + 1] ?? ''; has = true; } i += 1; continue; }
    if (c === '\'') { const e = line.indexOf('\'', i + 1); const to = e < 0 ? line.length : e; word += line.slice(i + 1, to); has = true; i = to; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j += 1) {
        if (line[j] === '\\') { word += line[j + 1] ?? ''; j += 1; } else if ((line[j] === '$' && line[j + 1] === '(') || line[j] === '`') { if (!word) dyn = true; word += '$'; j = inner(j); } else { if (line[j] === '$' && !word) dyn = true; word += line[j]; }
      }
      has = true; i = j; continue;
    }
    if ((c === '$' && line[i + 1] === '(') || c === '`') { if (!word) dyn = true; word += '$'; has = true; i = inner(i); continue; }
    if (c === '$' && !word) { dyn = true; word += c; has = true; continue; }
    if (c === '#' && !has) { const e = line.indexOf('\n', i); i = e < 0 ? line.length : e - 1; continue; }
    if (c === '&' && /[<>]$/.test(word)) { word += c; continue; } // 2>&1
    if (';&|\n('.includes(c)) { end(); cmd = true; wrap = false; continue; }
    if (c === ')') { end(); cmd = false; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { end(); continue; }
    word += c; has = true;
  }
  end();
  return out;
}

// the end of the string or template that opens at `i`
function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\\') j += 1;
    else if (c === q) return j + 1;
    else if (q === '`' && c === '$' && s[j + 1] === '{') j = closeOf(s, j + 1);
    else if (q !== '`' && c === '\n') return j;
  }
  return s.length;
}
// the index of the bracket that closes the one at `open`
function closeOf(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(s, i) - 1; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { depth -= 1; if (!depth) return i; }
  }
  return s.length - 1;
}
// `c ? x : y` → [x, y] (top level), or null
function ternary(s) {
  let depth = 0; let q = -1; let nest = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(s, i) - 1; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (!depth && c === '?') {
      if (s[i + 1] === '.' || s[i + 1] === '?') { i += 1; continue; }
      if (q < 0) q = i; else nest += 1;
    } else if (!depth && c === ':' && q >= 0) {
      if (nest) { nest -= 1; continue; }
      return [{ text: s.slice(q + 1, i).trim() }, { text: s.slice(i + 1).trim() }];
    }
  }
  return null;
}
// the top-level pieces of `s` between the separators `seps` (each a string), with where each starts
function splitTop(s, seps = [',']) {
  const out = []; let depth = 0; let from = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(s, i) - 1; continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (!depth) {
      const sep = seps.find((x) => s.startsWith(x, i));
      if (sep) { out.push({ text: s.slice(from, i), at: from }); i += sep.length - 1; from = i + 1; }
    }
  }
  out.push({ text: s.slice(from), at: from });
  return out.map((p) => ({ text: p.text.trim(), at: p.at + p.text.length - p.text.trimStart().length }));
}
/** The source with its comments and the bodies of its regular expressions blanked — same length, same lines: a word in a
    comment is no call, and a quote in a regex opens no string. */
export function blankCode(src, strings = false) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const open = []; // the braces open in each `${…}` of a template we are in
  // the text of a template from `j`: back to the code at its end or at a `${`
  const template = (j) => {
    for (; j < src.length; j += 1) {
      if (src[j] === '\\') { if (strings) blank(j, j + 2); j += 1; } else if (src[j] === '`') return j + 1;
      else if (src[j] === '$' && src[j + 1] === '{') { open.push(0); return j + 2; } else if (strings) blank(j, j + 1);
    }
    return src.length;
  };
  let i = 0; let prev = '';
  if (src.startsWith('#!')) { i = src.indexOf('\n') < 0 ? src.length : src.indexOf('\n'); blank(0, i); }
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (open.length && c === '}' && !open[open.length - 1]) { open.pop(); i = template(i + 1); prev = '`'; continue; }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '`') { i = template(i + 1); prev = '`'; continue; }
    if (c === '\'' || c === '"') { const end = skipString(src, i); if (strings) blank(i + 1, end - 1); i = end; prev = c; continue; }
    if (c === '/' && (!prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void)\s*$/.test(src.slice(Math.max(0, i - 12), i)))) {
      let j = i + 1; let cls = false;
      for (; j < src.length && src[j] !== '\n'; j += 1) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; prev = '/'; continue; }
    }
    if (open.length && c === '{') open[open.length - 1] += 1;
    if (open.length && c === '}') open[open.length - 1] -= 1;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

export function bareStarts(raw, file, allowed = {}) {
  const src = blankCode(raw);
  const bare = blankCode(raw, true);
  const inString = (at) => bare[at] !== src[at];
  const all = (re, text = src) => [...text.matchAll(re)].filter((m) => !inString(m.index));
  const ok = new Set(allowed[file] || []);
  const found = [];
  const say = (at, what) => found.push(`${file}:${src.slice(0, at).split('\n').length}: ${what}`);
  const names = new Map(); // what holds a function of child_process → which one (null: not one of FNS)
  const spaces = new Set(); // what holds child_process itself
  const pathFns = new Set(['fileURLToPath', 'join', 'resolve', 'realpathSync']);
  const locals = (list) => list.split(',').map((n) => n.trim()).filter(Boolean)
    .map((n) => { const [a, b] = n.split(/\s+as\s+|\s*:\s*/); return { from: a.trim(), as: (b || a).trim() }; });
  const fnOf = (from) => (FNS.includes(from) ? from : null);
  for (const m of all(/import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (/^(?:node:)?child_process$/.test(m[3])) locals(m[1]).forEach((n) => names.set(n.as, fnOf(n.from)));
    if (m[3].startsWith('.')) locals(m[1]).filter((n) => n.from === 'bin' || n.from === 'onPath').forEach((n) => pathFns.add(n.as)); // src/bin-path.js
  }
  const MOD = String.raw`(?:require\s*\(\s*${CP_MOD}\s*\)|\(\s*await\s+import\s*\(\s*${CP_MOD}\s*\)\s*\))`;
  for (const m of all(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${MOD}|await\s+import\s*\(\s*${CP_MOD}\s*\))`, 'g'))) locals(m[1]).forEach((n) => names.set(n.as, fnOf(n.from)));
  for (const m of all(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*${CP_MOD}`, 'g'))) spaces.add(m[1]);
  for (const m of all(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:require|await\s+import)\s*\(\s*${CP_MOD}\s*\)`, 'g'))) spaces.add(m[1]);
  // the module in a variable — is out of the guard's sight
  const FN_NAME = String.raw`(?:${FNS.join('|')})(?![\w$])`;
  for (const m of all(new RegExp(CP_MOD, 'g'))) {
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    if (/\bfrom\s*$|(?:^|[;\n])\s*import\s+$/.test(before)) continue; // import … from / export … from (judged below)
    const held = /(?:(?:const|let|var)\s*)?(?:\{[^}]*\}|[\w$]+)\s*=\s*(?:(?<![\w.$])require|await\s+import)\s*\(\s*$/.test(before) && /^\s*\)(?!\s*[.(\[])/.test(after);
    const called = /(?<![\w.$])require\s*\(\s*$/.test(before) && new RegExp(String.raw`^\s*\)\s*\.\s*${FN_NAME}`).test(after);
    const awaited = /\(\s*await\s+import\s*\(\s*$/.test(before) && new RegExp(String.raw`^\s*\)\s*\)\s*\.\s*${FN_NAME}`).test(after);
    if (!held && !called && !awaited) say(m.index, 'child_process reached where the guard cannot follow it');
  }
  const fnRef = () => {
    const owners = [...[...spaces].map((s) => String.raw`(?<![\w.$])${esc(s)}`), MOD];
    return [...[...names.keys()].map((n) => String.raw`(?<![\w.$])${esc(n)}(?![\w$])`), String.raw`(?:${owners.join('|')})\s*\.\s*(?:${FNS.join('|')})(?![\w$])`].join('|');
  };
  const callable = () => String.raw`(?:(?:util\s*\.\s*)?promisify\s*\(\s*(?:${fnRef()})\s*\)|(?:${fnRef()}))`;
  // which function of child_process a callable text names: `cp.exec`, `promisify(execFile)`, `run`
  const fnIn = (text) => {
    const member = new RegExp(String.raw`\.\s*(${FNS.join('|')})(?![\w$])`).exec(text);
    if (member) return member[1];
    for (const [n, f] of names) if (new RegExp(String.raw`(?<![\w.$])${esc(n)}(?![\w$])`).test(text)) return f;
    return null;
  };
  // another name for the same function or module: `const run = execFile`, `x = promisify(cp.execFile)`, `.bind(null)`,
  // `const { execFile: run } = cp`, `const cp2 = cp`
  for (let grew = true; grew;) {
    grew = false;
    const addName = (n, f) => { if (!names.has(n)) { names.set(n, f); grew = true; } };
    for (const m of all(new RegExp(String.raw`(?<![\w.$])(\w+)\s*=(?![=>])\s*${callable()}(?:\s*\.\s*bind\s*\(\s*[\w.$]*\s*\))?(?!\s*[\w$.(\[])`, 'g'))) addName(m[1], fnIn(m[0].slice(m[0].indexOf('=') + 1)));
    const own = [...spaces].map((s) => String.raw`(?<![\w.$])${esc(s)}`).concat(MOD).join('|');
    for (const m of all(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${own})(?![\w$.(])`, 'g'))) locals(m[1]).forEach((n) => addName(n.as, fnOf(n.from)));
    for (const m of all(new RegExp(String.raw`(?<![\w.$])(\w+)\s*=(?![=>])\s*(?:${own})(?![\w$.(\[])`, 'g'))) if (!spaces.has(m[1])) { spaces.add(m[1]); grew = true; }
  }
  // child_process handed on is out of the guard's sight: a re-export, or an export of a name that holds it
  for (const m of all(new RegExp(String.raw`export\s*(?:\*|\{[^}]*\})\s*from\s*${CP_MOD}`, 'g'))) say(m.index, 'child_process exported on');
  for (const m of all(/export\s*\{([^}]*)\}(?!\s*from)/g)) for (const n of locals(m[1])) if (names.has(n.from) || spaces.has(n.from)) say(m.index, `${n.from} exported on`);
  for (const m of all(/export\s+(?:const|let|var)\s+(\w+)/g)) if (names.has(m[1]) || spaces.has(m[1])) say(m.index, `${m[1]} exported on`);
  for (const m of all(new RegExp(String.raw`export\s+default\s+(?:${callable()}|${MOD})(?!\s*[\w$.(\[])`, 'g'))) say(m.index, 'child_process exported on');

  // the functions of the file: name, parameters, body
  const fns = [];
  const paramList = (open) => splitTop(src.slice(open + 1, closeOf(src, open))).map((p) => ({ ...p, at: open + 1 + p.at }));
  const paramNames = (open) => paramList(open).map((p) => (/^(?:\.\.\.)?\s*([\w$]+)/.exec(p.text) || [])[1] || null);
  const paramDefaults = (open) => paramList(open).map((p) => {
    const d = /^[\w$]+\s*=(?![=>])\s*/.exec(p.text);
    return d ? { text: p.text.slice(d[0].length), at: p.at + d[0].length } : null;
  });
  const bodyOf = (from) => {
    const at = from + (/^\s*/.exec(src.slice(from))[0].length);
    if (src[at] === '{') return { start: at, end: closeOf(src, at), block: true };
    return { start: at, end: valueAt(at).end, block: false };
  };
  for (const m of all(/(?:(export)\s+)?(?:async\s+)?function\s*\*?\s*([\w$]*)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const brace = src.indexOf('{', closeOf(src, open));
    // a function EXPRESSION's own name is seen only inside it (`{ go: function run(cmd) {…} }` is called as `x.go`):
    const before = src.slice(Math.max(0, m.index - 200), m.index).trimEnd();
    const expression = /[:(,=?[!&|]$|(?:^|[^\w$.])return$/.test(before);
    const name = expression ? ((/(?:const|let|var)\s+([\w$]+)\s*=$/.exec(before) || [])[1] || null) : (m[2] || null);
    fns.push({ name, exported: Boolean(m[1]), head: m.index, params: paramNames(open), defaults: paramDefaults(open), ...bodyOf(brace) });
  }
  for (const m of all(/(?:(export)\s+)?(?:(?:const|let|var)\s+([\w$]+)\s*=\s*)?(?:async\s*)?(\(|[\w$]+\s*=>)/g)) {
    let params; let after; let defaults = [];
    if (m[3] === '(') {
      const open = m.index + m[0].length - 1;
      const close = closeOf(src, open);
      const arrow = /^\s*=>/.exec(src.slice(close + 1));
      if (!arrow) continue;
      params = paramNames(open); defaults = paramDefaults(open); after = close + 1 + arrow[0].length;
    } else {
      params = [/^[\w$]+/.exec(m[3])[0]]; after = m.index + m[0].length;
    }
    fns.push({ name: m[2] || null, exported: Boolean(m[1]), head: m.index, params, defaults, ...bodyOf(after) });
  }
  // the brace and bracket pairs of the code: the blocks a `const` lives in, and the patterns of `[a, b] = …`
  const blocks = []; const patterns = [];
  {
    const stack = [];
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (c === '\'' || c === '"' || c === '`') { i = skipString(src, i) - 1; continue; }
      if (c === '{' || c === '[') stack.push([c, i]);
      else if (c === '}' || c === ']') {
        const want = c === '}' ? '{' : '[';
        while (stack.length && stack[stack.length - 1][0] !== want) stack.pop();
        if (!stack.length) continue;
        const [, open] = stack.pop();
        if (c === '}') blocks.push([open, i]);
        const eq = /^\s*=(?![=>])\s*/.exec(src.slice(i + 1, i + 40));
        const lead = src.slice(Math.max(0, open - 200), open);
        // a statement of its own — not `a[i] =`, not `const [a] =` (a declaration), not a default of a parameter
        if (eq && /(?:^|[;{}]|\n)\s*$/.test(lead) && !/[\w$)\]]\s*$/.test(lead) && !/(?:const|let|var)\s*$/.test(lead)) patterns.push({ open, close: i, value: i + 1 + eq[0].length });
      }
    }
  }
  // is a declaration at `d` seen at `at`: `at` is inside the innermost block around `d`
  const visible = (d, at) => {
    let best = null;
    for (const b of blocks) if (b[0] < d && d < b[1] && (!best || b[0] > best[0])) best = b;
    return !best || (best[0] <= at && at <= best[1]);
  };
  for (const f of fns) if (f.name && new RegExp(String.raw`export\s*\{[^}]*(?<![\w$])${esc(f.name)}(?![\w$])[^}]*\}(?!\s*from)`).test(src)) f.exported = true;
  const named = (name) => fns.find((f) => f.name === name);

  // the value set at `i`, up to the end of its statement
  function valueAt(i) {
    let depth = 0; let j = i;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === '\'' || c === '"' || c === '`') { j = skipString(src, j) - 1; continue; }
      if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) { if (!depth) break; depth -= 1; } else if (!depth && (c === ';' || c === ',')) break;
      else if (!depth && c === '\n' && !/^\s*(?:\|\||\?\?|&&|\?|:|\.|\+)/.test(src.slice(j + 1))) break;
    }
    return { expr: src.slice(i, j).trim(), end: j };
  }
  const argsOf = (open) => splitTop(src.slice(open + 1, closeOf(src, open))).map((p) => ({ text: p.text, at: open + 1 + p.at })).filter((p, k, all) => p.text || k < all.length - 1);

  // every place between `from` and `to` that sets the name again: `x = …`, and a pattern `[x] = […]` / `({ x } = …)`
  function assignments(name, from = 0, to = src.length) {
    const sets = [];
    for (const m of all(new RegExp(String.raw`(?<![\w.$])(?<!(?:const|let|var)\s+)${esc(name)}\s*=(?![=>])\s*`, 'g'))) if (m.index > from && m.index < to) sets.push(valueAt(m.index + m[0].length));
    const word = new RegExp(String.raw`(?<![\w$.])${esc(name)}(?![\w$])`);
    for (const p of patterns) if (p.open > from && p.open < to && word.test(src.slice(p.open + 1, p.close))) sets.push(valueAt(p.value));
    return sets;
  }
  // where a plain name gets its value: the parameter it is, or every place it is set. `sh`: the value is a shell line
  function judgeName(name, at, seen, sh) {
    const decls = [...all(new RegExp(String.raw`(?:(?:const|let|var)\s+${esc(name)}(?![\w$])\s*(=(?![=>]))?|for\s*\(\s*(?:const|let|var)\s+${esc(name)}\s+of\s+)`, 'g'))]
      .filter((m) => m.index < at && visible(m.index, at));
    const decl = decls.pop();
    const fn = fns.filter((f) => f.start <= at && at <= f.end && f.params.includes(name)).sort((a, b) => b.start - a.start)[0];
    if (fn && !(decl && decl.index > fn.start)) {
      const key = `p:${fn.head}:${name}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const w = judgeParam(fn, fn.params.indexOf(name), seen, sh);
      if (w) return w;
      for (const s of assignments(name, fn.start, fn.end)) { const v = judge(s.expr, s.end, seen, sh); if (v) return v; }
      return null;
    }
    if (!decl) return sh ? null : name;
    const key = `v:${decl.index}:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const sets = [];
    if (decl[0].startsWith('for')) sets.push(valueAt(decl.index + decl[0].length));
    else if (decl[1]) sets.push({ ...valueAt(decl.index + decl[0].length), at: decl.index });
    // every later assignment of the name — a `let` set to a full path and then to a bare name passed before
    sets.push(...assignments(name));
    for (const s of sets) { const w = judge(s.expr, s.at ?? s.end, seen, sh); if (w) return w; }
    return null;
  }
  // a parameter: its default, and what every call of its function gives it — directly, or through the function it is
  // handed to. In a shell line (`sh`) what cannot be followed is not read: only the text of the line is
  function judgeParam(fn, k, seen, sh) {
    const name = fn.params[k];
    const d = fn.defaults && fn.defaults[k];
    if (d) { const w = judge(d.text, d.at, seen, sh); if (w) return w; }
    const lost = (why) => (sh ? null : why);
    if (!fn.name) return lost(`${name} (a parameter of a function with no name to follow)`);
    if (fn.exported) return lost(`${name} (a parameter of ${fn.name}, which other files call)`);
    for (const m of all(new RegExp(String.raw`(?<![\w.$])${esc(fn.name)}\s*\(`, 'g'))) {
      if (/function\s*\*?\s*$/.test(src.slice(0, m.index))) continue;
      const a = argsOf(m.index + m[0].length - 1)[k];
      if (a) { const w = judge(a.text, a.at, seen, sh); if (w) return w; }
    }
    for (const m of all(new RegExp(String.raw`(?<![\w.$])${esc(fn.name)}(?![\w$]|\s*\(|\s*=(?![=>]))`, 'g'))) {
      if (/(?:function\s*\*?|const|let|var)\s*$/.test(src.slice(0, m.index)) || (m.index >= fn.head && m.index < fn.start)) continue;
      // handed as an argument to a function of the file: follow what that one calls it with
      const through = fns.filter((g) => g.name).flatMap((g) => all(new RegExp(String.raw`(?<![\w.$])${esc(g.name)}\s*\(`, 'g'))
        .map((c) => ({ g, j: argsOf(c.index + c[0].length - 1).findIndex((a) => a.at === m.index && a.text === fn.name) })).filter((x) => x.j >= 0));
      if (!through.length) return lost(`${fn.name} (handed where its calls cannot be followed)`);
      for (const { g, j } of through) {
        const p = g.params[j];
        if (!p) return lost(`${fn.name} (handed where its calls cannot be followed)`);
        for (const c of all(new RegExp(String.raw`(?<![\w.$])${esc(p)}\s*\(`, 'g')).filter((x) => x.index > g.start && x.index < g.end)) {
          const a = argsOf(c.index + c[0].length - 1)[k];
          if (a) { const w = judge(a.text, a.at, seen, sh); if (w) return w; }
        }
      }
    }
    return null;
  }
  // what a function of the file returns
  function returnsOf(name) {
    const f = named(name);
    if (!f) return null;
    if (!f.block) return [{ text: src.slice(f.start, f.end).trim(), at: f.start }];
    return all(/(?<![\w$.])return\s+/g).filter((m) => m.index > f.start && m.index < f.end).map((m) => ({ text: valueAt(m.index + m[0].length).expr, at: m.index }));
  }
  const LIST_PICK = String.raw`(?:\.\s*(?:find|filter)\s*\([\s\S]*\)(?:\s*\[\s*0\s*\])?|\[\s*0\s*\]|\.\s*at\s*\(\s*0\s*\))`;
  // a shell line written in the file: every word where the shell starts a program (`sh` = 'args': the line goes on
  // after a program and its first word is an argument — the arguments of `{ shell: true }`)
  function shellLine(body, q, at, seen, sh) {
    const holes = [];
    let line = '';
    for (let j = 0; j < body.length; j += 1) {
      if (body[j] === '\\') { const ch = body[j + 1] ?? ''; line += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch; j += 1; } else if (q === '`' && body[j] === '$' && body[j + 1] === '{') {
        const close = closeOf(body, j + 1);
        holes.push(body.slice(j + 2, close));
        line += `\u0001${holes.length - 1}\u0002`;
        j = close;
      } else line += body[j];
    }
    const shown = (w) => w.replace(/\u0001(\d+)\u0002/g, (x, n) => `\${${holes[n]}}`);
    for (const w of shellCommands(line, sh !== 'args')) {
      const hole = /^\u0001(\d+)\u0002/.exec(w.text);
      if (hole) {
        const rest = w.text.slice(hole[0].length);
        if (rest.includes('/')) continue; // `${folder}/bin/x` — a path under something
        if (rest && !rest.includes('\u0001')) return shown(w.text);
        const v = judge(holes[hole[1]], at, seen, true);
        if (v) return v;
        continue;
      }
      if (w.dyn || !w.text || w.text.includes('/') || SH_OK.has(w.text)) continue;
      return shown(w.text);
    }
    return null;
  }
  function judge(text, at, seen = new Set(), sh = false) {
    let expr = String(text).trim();
    while (expr.startsWith('(') && closeOf(expr, 0) === expr.length - 1) expr = expr.slice(1, -1).trim();
    if (ok.has(expr) || /^(?:null|undefined|false)$/.test(expr)) return null;
    let parts = splitTop(expr, ['||', '??']);
    if (parts.length === 1) parts = ternary(expr) || parts; // c ? x : y — each side
    if (parts.length > 1) { for (const p of parts) { const w = judge(p.text, at, seen, sh); if (w) return w; } return null; }
    if (/^await\s/.test(expr)) return judge(expr.replace(/^await\s+/, ''), at, seen, sh);
    if (/^process\.execPath$/.test(expr) || /^new URL\(/.test(expr)) return null;
    if (/^[\w$]+(?:\??\.[\w$]+)*\??\.cmd$/.test(expr)) return null; // every `cmd:` is judged where it is written
    const lit = /^(['"`])([\s\S]*)\1$/.exec(expr);
    if (lit && closeOfString(expr) && sh) return shellLine(lit[2], lit[1], at, seen, sh);
    if (lit && closeOfString(expr)) {
      const body = lit[2].trimStart();
      if (lit[1] === '`' && body.startsWith('${')) {
        const close = closeOf(body, 1);
        const rest = /^\S*/.exec(body.slice(close + 1))[0];
        if (rest.includes('/')) return null; // `${folder}/bin/x` — a path under something
        return rest ? `${body.slice(0, close + 1)}${rest}` : judge(body.slice(2, close), at, seen);
      }
      const word = body.split(/\s+/)[0];
      return word.includes('/') ? null : (word || '(nothing)');
    }
    if (expr.startsWith('[')) {
      const close = closeOf(expr, 0);
      const rest = expr.slice(close + 1).trim();
      const items = splitTop(expr.slice(1, close)).filter((p) => p.text);
      if (/^\.\s*join\s*\(/.test(rest)) return items.length ? judge(items[0].text, at, seen, sh) : null; // a command line shown: its first word
      if (!rest || new RegExp(`^${LIST_PICK}$`).test(rest)) { for (const p of items) { const w = judge(p.text, at, seen, sh); if (w) return w; } return null; }
      return sh ? null : expr;
    }
    const pick = new RegExp(String.raw`^([\w$]+)\s*${LIST_PICK}$`).exec(expr);
    if (pick) return judge(pick[1], at, seen, sh);
    const call = /^([\w$]+)\s*\(/.exec(expr);
    if (call && closeOf(expr, call[0].length - 1) === expr.length - 1) {
      if (pathFns.has(call[1])) return null;
      const key = `f:${call[1]}`;
      if (seen.has(key)) return null;
      const rets = returnsOf(call[1]);
      if (!rets) return sh ? null : expr;
      seen.add(key);
      for (const r of rets) { const w = judge(r.text, r.at, seen, sh); if (w) return w; }
      return null;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) return judgeName(expr, at, seen, sh);
    return sh ? null : expr;
  }
  const closeOfString = (s) => skipString(s, 0) === s.length;

  const items = (p) => (p && p.text.startsWith('[') && closeOf(p.text, 0) === p.text.length - 1
    ? splitTop(p.text.slice(1, -1)).filter((x) => x.text).map((x) => ({ text: x.text, at: p.at + 1 + x.at })) : null);
  const judgeCall = (fn, args) => {
    const [a, list, ...rest] = args;
    const what = judge(a.text, a.at);
    // the line of exec goes to a shell: its first word may be a builtin or VAR=value, read with the rest of the line
    if (what && !((fn === 'exec' || fn === 'execSync') && (SH_OK.has(what) || /^[A-Za-z_]\w*=/.test(what)))) return what;
    const shell = rest.concat(list || []).some((p) => /(?<![\w$.])shell\s*:\s*(?!false\b|null\b|undefined\b|0\b|''|"")/.test(p.text));
    // the line of `exec` and of `{ shell: true }`: the program and every command after it
    if (fn === 'exec' || fn === 'execSync' || shell) {
      const w = judge(a.text, a.at, new Set(), true);
      if (w) return w;
      // Node joins the arguments with spaces into the same line: read them joined, a value not written here as `$x`
      const joined = ((shell && items(list)) || []).map((p) => (/^(['"])[\s\S]*\1$/.test(p.text) && closeOfString(p.text) ? p.text.slice(1, -1) : '$x'));
      if (joined.length) { const v = judge(JSON.stringify(joined.join(' ')), list.at, new Set(), 'args'); if (v) return v; }
    }
    const xs = items(list);
    if (!xs) return null;
    // a shell and `-c`: the line after it
    const c = xs.findIndex((p) => /^(['"`])-[A-Za-z]*c[A-Za-z]*\1$/.test(p.text));
    if (SHELL_PROG.test(a.text) && c >= 0 && xs[c + 1]) { const w = judge(xs[c + 1].text, xs[c + 1].at, new Set(), true); if (w) return w; }
    // env, nohup, nice, timeout, …: the program among their arguments
    if (WRAP_PROG.test(a.text)) {
      const p = xs.find((x) => !/^(['"`])(?:-|[A-Za-z_]\w*=|\d+(?:\.\d+)?[smhd]?\1)/.test(x.text));
      if (p) { const w = judge(p.text, p.at, new Set(), true); if (w) return w; }
    }
    return null;
  };
  for (const m of all(new RegExp(String.raw`${callable()}\s*(?:\.\s*(call|apply|bind)\s*)?\(`, 'g'))) {
    const args = argsOf(m.index + m[0].length - 1);
    let a = args[0];
    if (m[1] === 'call' || m[1] === 'bind') a = args[1];
    if (m[1] === 'apply') a = args[1] && args[1].text.startsWith('[') ? { text: splitTop(args[1].text.slice(1, closeOf(args[1].text, 0)))[0].text, at: args[1].at } : args[1];
    if (!a) { if (m[1] !== 'bind') say(m.index, '(no program)'); continue; }
    const what = m[1] ? judge(a.text, a.at) : judgeCall(fnIn(m[0]), args);
    if (what) say(m.index, what);
  }
  // `run(execFile)`, `{ execFile }` — or the module read by a computed key (`cp['execFile']`): the guard cannot see its calls
  const refs = [...names.keys(), ...spaces].map((n) => String.raw`(?<![\w.$])${esc(n)}(?![\w$])`);
  for (const m of refs.length ? all(new RegExp(refs.join('|'), 'g')) : []) {
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    if (spaces.has(m[0]) ? /^\s*\.\s*[\w$]/.test(after) : /^\s*(?:\(|\.\s*(?:call|apply|bind)\s*\()/.test(after)) continue; // a call, read above
    if (/promisify\s*\(\s*$/.test(before) && /^\s*\)/.test(after)) continue;
    if (/(?:(?<![\w.$])[\w$]+|\})\s*=(?![=>])\s*$/.test(before) || /(?:const|let|var|typeof)\s+$/.test(before) || /^\s*(?:=(?![=>])|:)/.test(after)) continue; // another name, its own declaration, a key
    if (/(?:(?:const|let|var|import|export)\s*\{[^}]*|import\s+(?:\*\s+as\s+)?|export\s+default\s+)$/.test(before)) continue; // an import, a destructuring, an export (judged above)
    const r = /Reflect\s*\.\s*apply\s*\(\s*$/.exec(before);
    if (r && !spaces.has(m[0])) {
      const args = argsOf(m.index - before.length + r.index + r[0].indexOf('('));
      const list = args[2] && (items(args[2]) || [args[2]]);
      if (!list || !list[0]) say(m.index, '(no program)');
      else { const w = judge(list[0].text, list[0].at); if (w) say(m.index, w); }
      continue;
    }
    say(m.index, `${m[0]} handed where its calls cannot be followed`);
  }
  // a spec of the board's code that something starts later: every `cmd` is judged where it is written (the tests hold
  if (!file.startsWith('test/')) {
    const KEY = "(?:'cmd'|\"cmd\"|`cmd`)";
    for (const m of all(new RegExp(String.raw`(?<=[{,]\s*)(?:cmd|${KEY}|\[\s*${KEY}\s*\])\s*:\s*`, 'g'))) { const w = judge(valueAt(m.index + m[0].length).expr, m.index); if (w) say(m.index, w); }
    for (const m of all(/(?<=(?:(?<!\$)\{|,)\s*)cmd(?=\s*[,}])/g)) { const w = judge('cmd', m.index); if (w) say(m.index, w); }
    for (const m of all(new RegExp(String.raw`(?:\.\s*cmd|\[\s*${KEY}\s*\])\s*=(?![=>])\s*`, 'g'))) { const w = judge(valueAt(m.index + m[0].length).expr, m.index); if (w) say(m.index, w); }
  }
  return found;
}

// where no value can be read — each with why it is a full path
const ALLOWED = {
  'src/sync/github.js': ['ghBinEnv()'], // KB_GH_BIN: the path the person gave, expanded in src/config.js; the rest of ghBin is read
};

test('the guard catches every way of writing a bare name', () => {
  const head = "import { execFile, execFileSync, exec, execSync, spawn as sp } from 'node:child_process';\nimport { promisify } from 'node:util';\nimport { bin } from '../src/bin-path.js';\n";
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

// name behind a wrapper or a fallback passed, and so did ways of reaching child_process it did not read
test('the guard reads the value behind a name: wrappers, fallbacks, returns, every assignment', () => {
  const head = "import { execFile } from 'node:child_process';\nimport { bin, onPath } from '../src/bin-path.js';\n";
  for (const [line, name, allowed] of [
    // a fallback of the function that names the program (src/sync/github.js ghBin)
    ["const FOUND = ['/usr/bin/gh'].find((p) => existsSync(p)) || null;\nconst ghBin = () => ghBinEnv() || FOUND || 'gh';\nexecFile(ghBin(), []);", 'gh', { 'x.js': ['ghBinEnv()'] }],
    ["function ghBin() { if (x) return bin('gh'); return 'gh'; }\nexecFile(ghBin(), []);", 'gh'],
    // a wrapper `run(cmd, …)` (src/stands.js, src/phantom.js): what each call gives it
    ["function run(cmd, args) { return new Promise((r) => { execFile(cmd, args, r); }); }\nrun(bin('git'), []);\nrun('du', ['-sk']);", 'du'],
    ["const tmuxBin = () => onPath('tmux') || 'tmux';\nfunction run(cmd, args) { execFile(cmd, args); }\nconst tmux = (...c) => run(tmuxBin(), c);", 'tmux'],
    ["export const spec = () => ({ cmd: 'tmux', args: [] });\nexport function runSpec(spec) { execFile(spec.cmd, spec.args); }", 'tmux'],
    ["const PLACES = ['/usr/bin/tmux', 'tmux'];\nexecFile(PLACES.find((p) => existsSync(p)), []);", 'tmux'],
    // a wrapper handed to another function (src/routes/system.js `exec` → runUpdate)
    ["const exec = (cmd, args) => new Promise((r) => execFile(cmd, args, r));\nasync function runUpdate(plan, ex) { await ex(plan.cmd, plan.args); await ex('npm', []); }\nrunUpdate(plan, exec);", 'npm'],
    ["const exec = (cmd) => execFile(cmd, []);\nsomewhere(exec);", 'exec (handed where its calls cannot be followed)'],
    ["export function run(cmd) { execFile(cmd, []); }", 'cmd (a parameter of run, which other files call)'],
    // a name set twice: the second value is the one started
    ["let tool = bin('git');\nif (x) tool = 'git';\nexecFile(tool, []);", 'git'],
    ["let TMUX = null;\nfor (const p of ['/usr/bin/tmux', 'tmux']) if (existsSync(p)) TMUX = p;\nexecFile(TMUX, []);", 'tmux'],
    ["execFile(x ? bin('git') : 'git', []);", 'git'], ["const tool = 'git';\nexecFile(`${tool}`, []);", 'git'],
    ["const spec = {};\nspec.cmd = 'git';", 'git'], ["const cmd = 'git';\nconst spec = { cmd, args: [] };", 'git'],
  ]) {
    const hits = bareStarts(head + line, 'x.js', allowed);
    assert.equal(hits.length, 1, `not caught: ${line} → ${JSON.stringify(hits)}`);
    assert.ok(hits[0].endsWith(`: ${name}`), `${line} → ${hits[0]}`);
  }
  for (const line of [
    "function run(cmd, args) { execFile(cmd, args); }\nrun(bin('git'), []);\nconst git = (a) => run(bin('git'), a);",
    "const tmuxBin = () => onPath('tmux') || ['/opt/homebrew/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p)) || null;\nfunction run(cmd) { execFile(cmd, []); }\nrun(tmuxBin());",
    "const exec = (cmd, args) => new Promise((r) => execFile(cmd, args, r));\nasync function runUpdate(plan, ex) { await ex(plan.cmd, plan.args); await ex(plan.then.cmd, []); }\nrunUpdate(plan, exec);",
    "export const spec = () => ({ cmd: bin('open'), args: [] });\nexport function runSpec(spec) { execFile(spec.cmd, spec.args); }",
    "const shells = ['/bin/sh', '/bin/bash'].filter(existsSync);\nfor (const sh of shells) execFile(sh, ['-c', 'true']);",
    "const H = [`${process.env.HOME}/.local/bin/gh`, '/usr/bin/gh'].find((p) => existsSync(p)) || bin('gh');\nexecFile(H, []);",
    "// execFile('git', [])\nconst s = \"execFile('git', [])\";\n/* spawn('git') */",
    "const shown = { cmd: [step.cmd, ...step.args].join(' ') };",
  ]) {
    assert.deepEqual(bareStarts(head + line, 'x.js'), [], `a full path read as bare: ${line}`);
  }
});

test('the guard follows every way to child_process: require, a promisified namespace, call/apply/bind, aliases, exports', () => {
  for (const [code, name] of [
    ["require('child_process').execFile('git', []);", 'git'],
    ["(await import('node:child_process')).execFileSync('git');", 'git'],
    ["import * as cp from 'node:child_process';\nimport util from 'node:util';\nutil.promisify(cp.execFile)('git', []);", 'git'],
    ["const cp = require('node:child_process');\nconst run = util.promisify(cp.execFile);\nrun('git');", 'git'],
    ["import { execFile } from 'node:child_process';\nexecFile.call(null, 'git', []);", 'git'],
    ["import { execFile } from 'node:child_process';\nexecFile.apply(null, ['git', []]);", 'git'],
    ["import { execFile } from 'node:child_process';\nconst git = execFile.bind(null, 'git');", 'git'],
    ["import { execFile } from 'node:child_process';\nconst run = execFile;\nrun('git', []);", 'git'],
    ["import { execFile } from 'node:child_process';\nlet run;\nrun = execFile;\nrun('git', []);", 'git'],
    ["import * as cp from 'node:child_process';\nconst { execFileSync: x } = cp;\nx('git');", 'git'],
    ["const { spawn } = require('child_process');\nspawn('git', []);", 'git'],
    ["export { execFile } from 'node:child_process';", 'child_process exported on'],
    ["export * from 'node:child_process';", 'child_process exported on'],
    ["import { execFile } from 'node:child_process';\nexport { execFile as run };", 'execFile exported on'],
    ["import { execFile } from 'node:child_process';\nexport const run = execFile;", 'run exported on'],
  ]) {
    const hits = bareStarts(code, 'x.js');
    assert.equal(hits.length, 1, `not caught: ${code} → ${JSON.stringify(hits)}`);
    assert.ok(hits[0].endsWith(`: ${name}`), `${code} → ${hits[0]}`);
  }
});

test('the guard reads defaults, scopes, patterns, quoted keys, shell lines, wrappers and the module reached another way', () => {
  const head = "import { execFile, exec, execSync, spawn } from 'node:child_process';\nimport { bin } from '../src/bin-path.js';\n";
  for (const [line, name] of [
    // a default of a parameter, a parameter set again, a function expression's own name
    ["function run(cmd = 'git', args = []) { return execFile(cmd, args); }\nrun();", 'git'],
    ["function run(cmd) { cmd = 'git'; execFile(cmd, []); }\nrun(bin('git'));", 'git'],
    ["const api = { go: function run(cmd) { return execFile(cmd, []); } };\napi.go('git');", 'cmd (a parameter of a function with no name to follow)'],
    // the key of a spec in quotes, computed, set by a computed member
    ["const spec = { 'cmd': 'git', args: [] };", 'git'], ['const spec = { "cmd": \'git\' };', 'git'],
    ["const spec = { ['cmd']: 'git', args: [] };", 'git'], ["const spec = {};\nspec['cmd'] = 'git';", 'git'],
    // a destructuring assignment, and a name of an inner block that is not the one used
    ["let tool = bin('git');\n[tool] = ['git'];\nexecFile(tool, []);", 'git'],
    ["const tool = 'git';\nfunction f() { const tool = bin('git'); return tool; }\nexecFile(tool, []);", 'git'],
    // Reflect.apply, and a function of child_process handed on
    ["Reflect.apply(execFile, null, ['git', []]);", 'git'], ['somewhere(execFile);', 'execFile handed where its calls cannot be followed'],
    // shell lines: `-c` of a shell, the line of exec, `{ shell: true }`, command substitution
    ["execFile(bin('sh'), ['-c', 'git status']);", 'git'], ["execFile('/bin/bash', ['-lc', 'cd /tmp && git status']);", 'git'],
    ["const sh = '/bin/sh';\nexecFile(sh, ['-c', `${'git'} status`]);", 'git'],
    ["execFile('/bin/sh', ['-c', 'echo \"$(git rev-parse HEAD)\"']);", 'git'],
    ["exec(`${bin('git')} status && git push`);", 'git'], ["execSync('cd /tmp; npm install');", 'npm'],
    ["spawn(`${bin('cd')} . ; git status`, { shell: true });", 'git'],
    ["spawn(bin('git'), ['status;', 'npm', 'i'], { shell: true });", 'npm'],
    ["const line = 'true && git fetch';\nexecFile('/bin/sh', ['-c', line]);", 'git'],
    // the program a wrapper starts — in a shell line and as an argument
    ["execFile('/bin/sh', ['-c', 'env FOO=1 git status']);", 'env'], ["execFile('/bin/sh', ['-c', '/usr/bin/env -i git status']);", 'git'],
    ["execFile(bin('env'), ['FOO=1', 'git', 'status']);", 'git'], ["execFile('/usr/bin/timeout', ['5', 'git', 'fetch']);", 'git'],
    // the module reached another way
    ["import('node:child_process').then((m) => m.execFile('git', []));", 'child_process reached where the guard cannot follow it'],
    ["import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('child_process').execFileSync('git');", 'child_process reached where the guard cannot follow it'],
    ["const MOD = 'node:child_process';\nconst cp = await import(MOD);\ncp.execFile('git', []);", 'child_process reached where the guard cannot follow it'],
    ['const cp = await import(`node:child_process`);\ncp.execFile(\'git\', []);', 'git'],
  ]) {
    const hits = bareStarts(head + line, 'x.js');
    assert.equal(hits.length, 1, `not caught: ${line} → ${JSON.stringify(hits)}`);
    assert.ok(hits[0].endsWith(`: ${name}`), `${line} → ${hits[0]}`);
  }
  const computed = bareStarts("import * as cp from 'node:child_process';\ncp['execFile']('git', []);", 'x.js');
  assert.deepEqual(computed.map((h) => h.replace(/^[^ ]+ /, '')), ['cp handed where its calls cannot be followed']);
  for (const line of [
    "execFile('/bin/sh', ['-c', 'umask 077; exec \"$@\"', 'sh', process.execPath]);",
    "execFile('/bin/sh', ['-c', `printf %s ${x} | ${bin('cat')} >/dev/null 2>&1`]);",
    "execFile('/bin/sh', ['-c', 'for f in a b; do echo $f; done; ( \"$0\" show ) | true']);",
    "exec(`${bin('git')} status && ${bin('git')} push`);", "execFile('/bin/sh', ['-c', line]);",
    "execFile(bin('env'), ['FOO=1', bin('git'), 'status']);", "execFile(bin('git'), ['-c', 'user.name=t', 'commit']);",
    "function f() { const tool = 'git'; return tool; }\nconst tool = bin('git');\nexecFile(tool, []);",
    "function run(cmd = bin('git')) { execFile(cmd, []); }\nrun();", "const spec = { cmd: bin('git') };\nspec['cmd'] = bin('npm');",
    "const re = { exec: 1 };\nconst run = execFile;\nrun(bin('git'));", "spawn(bin('git'), ['status'], { shell: false });",
  ]) {
    assert.deepEqual(bareStarts(head + line, 'x.js'), [], `a full path read as bare: ${line}`);
  }
  assert.deepEqual(bareStarts("const { execFile: run } = await import('node:child_process');\nrun(process.execPath, []);", 'x.js'), []);
});

// every program the board and its tests start goes by the full path: a bare name in execFile/spawn is the stream again
test('the server, the CLI and the tests start no program by a bare name', () => {
  const root = new URL('..', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk(join(root, 'src'));
  walk(join(root, 'test'));
  // scripts/ is left out on purpose: release.js runs once a release, from the owner's shell, never beside the board or
  // its tests — its bare `git`/`npm`/`gh` are no stream
  for (const b of ['bin/kb', 'bin/local-kanban']) if (existsSync(join(root, b))) files.push(join(root, b));
  const bare = files.filter((f) => !f.endsWith('test/bin-path.test.js')).flatMap((f) => bareStarts(readFileSync(f, 'utf8'), f.slice(root.length), ALLOWED));
  assert.deepEqual(bare, [], 'started by a bare name — use bin() from src/bin-path.js');
});
