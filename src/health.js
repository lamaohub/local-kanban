import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { claudeDir, expandPath } from './config.js';

export const NORMS = { lines: 200, file_chars: 40000, total_chars: 120000 };
const SKIP_BYTES = 4 * 1024 * 1024;
const IMPORT_HOPS = 4;
const NESTED_DEPTH = 6;
const NESTED_DIRS_MAX = 4000; // a folder of a project is walked no further than this many folders
const NOT_PROJECT_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'coverage', '.claude']);

const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

/** The paths a memory file imports: `@path` outside code spans and fenced blocks, `\ ` for a space (the docs). */
export function importsOf(text) {
  const out = [];
  let fence = null;
  for (const raw of String(text).split('\n')) {
    const f = raw.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/`[^`]*`/g, ' ');
    for (const m of line.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) out.push(m[1].replace(/\\ /g, ' '));
  }
  return out;
}

/** A rule of .claude/rules/ loads at the start only without `paths:` in its front matter. */
export function ruleIsScoped(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return Boolean(m && /^paths\s*:/m.test(m[1]));
}

async function readMemory(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    if (s.size > SKIP_BYTES) return { skipped: true, text: '' };
    return { text: await readFile(path, 'utf8') };
  } catch { return null; }
}

const shown = (p) => {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
};

/** One measured file and, depth first, what it imports. `seen` — real paths already counted (a file loads once). */
async function measure(path, kind, seen, out, { from = null, hop = 0 } = {}) {
  let real;
  try { real = await realpath(path); } catch { return; }
  if (seen.has(real)) return;
  const got = await readMemory(real);
  if (!got) return;
  seen.add(real);
  out.push({ path: shown(path), kind, chars: got.text.length, lines: lineCount(got.text), ...(from ? { from: shown(from) } : {}), ...(got.skipped ? { skipped: true } : {}) });
  if (hop >= IMPORT_HOPS) return;
  for (const ref of importsOf(got.text)) {
    const target = ref.startsWith('~/') ? expandPath(ref) : isAbsolute(ref) ? ref : resolve(dirname(path), ref);
    await measure(target, 'import', seen, out, { from: path, hop: hop + 1 });
  }
}

async function rulesIn(dir, seen, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { await rulesIn(p, seen, out); continue; }
    if (!e.name.endsWith('.md')) continue;
    const got = await readMemory(p);
    if (!got || ruleIsScoped(got.text)) continue;
    await measure(p, 'rule', seen, out);
  }
}

/** The folders from the root down to `dir`. */
function chain(dir) {
  const dirs = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === parse(d).root) break;
  }
  return dirs;
}

async function nestedOf(root, seen) {
  const out = [];
  let walked = 0;
  const walk = async (dir, depth) => {
    if (walked++ > NESTED_DIRS_MAX) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (dir !== root) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
        if (!entries.some((e) => e.isFile() && e.name === name)) continue;
        const p = join(dir, name);
        let real;
        try { real = await realpath(p); } catch { continue; }
        if (seen.has(real)) continue;
        const got = await readMemory(real);
        if (got) out.push({ path: relative(root, p), kind: 'nested', chars: got.text.length, lines: lineCount(got.text) });
      }
    }
    if (depth >= NESTED_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !NOT_PROJECT_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => b.chars - a.chars);
}

/* The auto memory of the project — Claude Code loads the first 200 lines or 25 KB of its MEMORY.md, whichever is less
   (the docs, «Auto memory»); only that part is counted. Its folder is the project's path with every other sign a `-`. */
const MEMORY_LINES = 200;
const MEMORY_BYTES = 25 * 1024;
async function memoryOf(top, files) {
  const path = join(claudeDir(), 'projects', top.replace(/[^A-Za-z0-9-]/g, '-'), 'memory', 'MEMORY.md');
  const got = await readMemory(path);
  if (!got || got.skipped) return;
  let text = got.text.split('\n').slice(0, MEMORY_LINES).join('\n');
  const bytes = Buffer.from(text);
  if (bytes.length > MEMORY_BYTES) text = bytes.subarray(0, MEMORY_BYTES).toString('utf8').replace(/\uFFFD$/, '');
  files.push({ path: shown(path), kind: 'memory', chars: text.length, lines: lineCount(text), ...(text.length < got.text.length ? { cut: got.text.length } : {}) });
}

const sum = (files, k) => files.reduce((n, f) => n + f[k], 0);

/** The files of the person — they load in every project. */
export async function everywhere() {
  const seen = new Set();
  const files = [];
  await measure(join(claudeDir(), 'CLAUDE.md'), 'user', seen, files);
  await rulesIn(join(claudeDir(), 'rules'), seen, files);
  return { files, chars: sum(files, 'chars'), lines: sum(files, 'lines'), seen };
}

/** What a session started in `dir` loads, apart from the person's own files (their real paths in `skip`). */
export async function projectHealth(dir, skip = new Set()) {
  const seen = new Set(skip);
  const files = [];
  const top = resolve(dir);
  for (const d of chain(top)) {
    const own = d === top;
    const before = files.length;
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) await measure(join(d, name), own ? 'main' : 'parent', seen, files);
    if (!files.slice(before).length) await measure(join(d, 'AGENTS.md'), own ? 'main' : 'parent', seen, files);
    for (const f of files.slice(before)) if (f.kind === 'main') f.name = relative(top, expandPath(f.path));
    await measure(join(d, 'CLAUDE.local.md'), 'local', seen, files);
  }
  await rulesIn(join(top, '.claude', 'rules'), seen, files);
  await memoryOf(top, files);
  const main = files.find((f) => f.kind === 'main') || null;
  return {
    main: main && { path: main.name, chars: main.chars, lines: main.lines },
    files, chars: sum(files, 'chars'), lines: sum(files, 'lines'),
    nested: await nestedOf(top, seen),
  };
}

/** The whole answer of GET /api/health: the norms, the person's files and each project that is not archived. */
export async function healthView(projects) {
  const user = await everywhere();
  const out = [];
  for (const p of projects) {
    const base = { slug: p.slug, name: p.name || p.slug, category: p.category || null };
    if (!p.path) { out.push({ ...base, folder: null }); continue; }
    let isDir = false;
    try { isDir = (await stat(p.path)).isDirectory(); } catch { /* no folder here */ }
    if (!isDir) { out.push({ ...base, folder: shown(p.path), missing: true }); continue; }
    out.push({ ...base, folder: shown(p.path), ...(await projectHealth(p.path, user.seen)) });
  }
  return { norms: NORMS, everywhere: { files: user.files, chars: user.chars, lines: user.lines }, projects: out };
}
