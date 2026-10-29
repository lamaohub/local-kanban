// was gone one day and Settings said "not set up" — while the Claude app kept its own copy of Claude Code, signed in and
// working. The board now looks on the PATH, in the places of the installers and in that copy of the app (its newest
// version); a terminal window is told the full path then, since it would not find claude by name either. With nothing
// found, Settings shows the install command itself, not only a page about it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, launch, rules;
const saved = {};
const ENV = ['HOME', 'PATH', 'KB_CLAUDE_BIN'];
const exe = (path) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755); return path; };
const appCopy = (home, version, build = 'b1') => join(home, 'Library', 'Application Support', 'Claude', 'claude-code', version, build, 'claude.app', 'Contents', 'MacOS', 'claude');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-find-'));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.KB_DATA_DIR = join(tmp, 'data');
  launch = await import('../src/launch.js');
  rules = await import('../public/js/claude-setup-rules.js');
});
after(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const home = () => { const h = join(tmp, `home-${++n}`); mkdirSync(h, { recursive: true }); process.env.HOME = h; return h; };

test('claude is found on the PATH first, then where an installer puts it, then in the Claude app', () => {
  delete process.env.KB_CLAUDE_BIN;
  process.env.PATH = join(tmp, 'nothing');
  const h = home();
  assert.equal(launch.findClaude(), null);
  assert.equal(launch.launchOptions().cli, false);
  if (process.platform === 'darwin') {
    exe(appCopy(h, '2.1.9'));
    const newest = exe(appCopy(h, '2.1.10', 'zz'));
    exe(appCopy(h, '2.1.2'));
    // 2.1.10 is newer than 2.1.9 — as a string it sorts lower
    assert.deepEqual(launch.findClaude(), { path: newest, from: 'app' });
    assert.equal(launch.appClaude(h, 'linux'), null, 'the Claude app keeps its copy this way only on a Mac');
    assert.equal(launch.launchOptions().cli, true, 'the Terminal way is not offered although claude is there');
  }
  const native = exe(join(h, '.local', 'bin', 'claude'));
  assert.deepEqual(launch.findClaude(), { path: native, from: 'place' });
  const bin = join(tmp, `bin-${n}`);
  const onPath = exe(join(bin, 'claude'));
  process.env.PATH = bin;
  assert.deepEqual(launch.findClaude(), { path: onPath, from: 'PATH' });
  process.env.KB_CLAUDE_BIN = join(tmp, 'gone');
  assert.deepEqual(launch.findClaude(), { path: join(tmp, 'gone'), from: 'KB_CLAUDE_BIN' }, 'KB_CLAUDE_BIN is the person\'s word, taken as written');
  process.env.PATH = join(tmp, 'nothing');
  assert.equal(launch.launchOptions().cli, false, 'KB_CLAUDE_BIN pointing nowhere passes for a Claude to start');
  delete process.env.KB_CLAUDE_BIN;
});

test('a file that cannot run, or a folder, is not a claude', () => {
  delete process.env.KB_CLAUDE_BIN;
  process.env.PATH = join(tmp, 'nothing');
  const h = home();
  mkdirSync(join(h, '.local', 'bin', 'claude'), { recursive: true });
  const p = join(h, '.claude', 'local', 'claude');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'not a program');
  assert.equal(launch.findClaude(), null);
});

test('a terminal window gets the full path of a claude off the PATH, and the plain name of one on it', () => {
  delete process.env.KB_CLAUDE_BIN;
  process.env.PATH = join(tmp, 'nothing');
  const h = home();
  const native = exe(join(h, '.local', 'bin', 'claude'));
  assert.equal(launch.claudeWord(), launch.shellQuote(native));
  const line = launch.terminalCommand({ text: 'x', session: 'a1a1a1a1-0000-4000-8000-000000000001', bin: launch.claudeWord() });
  assert.ok(line.includes(`${launch.shellQuote(native)} --session-id`), line);
  assert.ok(launch.terminalCommand({ resume: 'a1a1a1a1-0000-4000-8000-000000000001', bin: launch.claudeWord() }).includes(`${launch.shellQuote(native)} --resume`));
  const bin = join(tmp, `bin-${n}`);
  exe(join(bin, 'claude'));
  process.env.PATH = bin;
  assert.equal(launch.claudeWord(), 'claude');
  assert.match(launch.terminalCommand({ text: 'x' }), /env -u CLAUDE_CODE_SIMPLE claude 'x'$/, 'the plain command changed');
});

test('Settings say where claude was found, and give the install command when it is nowhere', () => {
  const base = { platform: 'darwin', tmux: { path: null }, app: { path: '/Applications/Claude.app', supported: true }, terminal: { ok: true } };
  const row = (claude) => rules.setupView({ ...base, claude }).flatMap((v) => v.rows).find((r) => r.id === 'claude');
  assert.match(row({ path: '/a/claude', from: 'app' }).note, /inside the Claude app/);
  assert.match(row({ path: '/h/.local/bin/claude', from: 'place' }).note, /where the installer puts it/);
  assert.equal(row({ path: '/usr/bin/claude', from: 'PATH' }).note, 'Starts tasks inside the board and in Terminal.');
  const missing = row({ path: null, from: 'PATH' });
  assert.equal(missing.fix.cmd, rules.INSTALL_CLAUDE_CMD);
  assert.equal(missing.fix.href, rules.INSTALL_CLAUDE_URL, 'the page with the rest (other systems) is gone');
  assert.equal(missing.say, true, 'the note asking to install hides in a hint');
});

test('the texts of where claude was found are translated, and the page shows a command with its page', async () => {
  const { readFileSync } = await import('node:fs');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../public/js/claude-setup-rules.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const CLAUDE_FROM = {'), src.indexOf('};', src.indexOf('const CLAUDE_FROM = {')));
  const texts = [...block.matchAll(/: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(texts.length, 3);
  for (const t of texts) assert.ok(core.includes(`'${t}':`), `no Russian for: ${t}`);
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const fix = settings.slice(settings.indexOf('function ccFix('), settings.indexOf('\n}\n', settings.indexOf('function ccFix(')));
  assert.match(fix, /if \(f\.cmd\) return `<pre[^\n]*f\.href \?/, 'a command hides the link to its page');
});

test('▶ in the Terminal names the claude the board found off the PATH by its full path', async () => {
  delete process.env.KB_CLAUDE_BIN;
  process.env.PATH = `${join(tmp, 'nothing')}:/usr/bin:/bin`;
  const h = home();
  const native = exe(join(h, '.local', 'bin', 'claude'));
  process.env.KB_LAUNCH_DRYRUN = '1';
  const { db } = await import('../src/db.js');
  const folder = join(tmp, 'proj folder');
  mkdirSync(folder, { recursive: true });
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('fnd','FND','Find',1,?)").run(folder);
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.ready();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'terminal', text: 'Do it', project: 'fnd' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(JSON.stringify(r.json()).includes(native), 'the Terminal is told a bare `claude` it would not find');
  } finally { await app.close(); delete process.env.KB_LAUNCH_DRYRUN; }
});

test('a KB_CLAUDE_BIN that points nowhere offers no start inside the board either', async () => {
  process.env.PATH = join(tmp, 'nothing');
  home();
  process.env.KB_CLAUDE_BIN = join(tmp, 'gone-too');
  try {
    const phantom = await import('../src/phantom.js');
    assert.equal(phantom.phantomAvailable(), false, 'a start inside the board is offered with no Claude to start');
    assert.equal(launch.claudeRunnable(), false);
  } finally { delete process.env.KB_CLAUDE_BIN; }
});
