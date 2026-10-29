// Settings → Claude Code: one answer of the server (GET /api/claude) says what this machine has of what the board
// needs from Claude Code — the programs ▶ starts tasks with, the Claude folder and what the board reads in it, the
// two entries in settings.json and when the limits came last — and the page connects the board from there (PUT /
// DELETE /api/claude/hooks), with the same careful write as `local-kanban hooks`. Each condition is checked both
// ways in folders of the test's own: the Claude folder (KB_CLAUDE_DIR), the data folder, PATH. What cannot be moved
// by the environment (tmux and the Claude app are looked for in fixed places) is handed in as a probe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import vm from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const PAGE = { origin: 'http://127.0.0.1:3100', 'sec-fetch-site': 'same-origin' };
const OWN = { model: 'opus', statusLine: { type: 'command', command: 'node /home/user/.claude/my-statusline.js', padding: 1 } };
let tmp, app, setup, limits, hooks;
const saved = {};
const ENV = ['KB_CLAUDE_DIR', 'CLAUDE_CONFIG_DIR', 'KB_CLAUDE_BIN', 'PATH', 'HOME'];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-setup-'));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_GH_BIN = join(tmp, 'no-gh');
  await import('../src/db.js');
  setup = await import('../src/claude-setup.js');
  limits = await import('../src/claude-limits.js');
  hooks = await import('../src/claude-hooks.js');
  app = Fastify();
  await app.register((await import('../src/routes/claude.js')).default);
  await app.ready();
});

after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await app?.close();
  if (tmp) { try { chmodSync(tmp, 0o755); } catch { /* fine */ } rmSync(tmp, { recursive: true, force: true }); }
});

let n = 0;
/** A Claude folder of its own for each case, and the environment that points the board at it. */
function claudeFolder({ make = true, via = 'KB_CLAUDE_DIR' } = {}) {
  const dir = join(tmp, `claude-${++n}`);
  if (make) mkdirSync(dir, { recursive: true });
  delete process.env.KB_CLAUDE_DIR; delete process.env.CLAUDE_CONFIG_DIR;
  if (via === 'default') { process.env.HOME = join(tmp, `home-${n}`); return join(process.env.HOME, '.claude'); }
  process.env[via] = dir;
  return dir;
}
const exe = (path) => { writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, 0o755); return path; };
const NONE = { tmux: () => null, app: () => null, terminal: () => false, platform: 'darwin' };

test('the programs: claude by KB_CLAUDE_BIN or on PATH, tmux, the Claude app, a terminal', async () => {
  claudeFolder();
  const bin = join(tmp, 'bin'); mkdirSync(bin, { recursive: true });
  delete process.env.KB_CLAUDE_BIN;
  process.env.PATH = '/nonexistent';
  process.env.HOME = join(tmp, 'home-empty');
  let d = await setup.claudeSetup(NONE);
  assert.deepEqual([d.claude.path, d.tmux.path, d.app.path, d.terminal.ok], [null, null, null, false]);
  assert.equal(d.app.supported, true);
  const onPath = exe(join(bin, 'claude'));
  process.env.PATH = `/nonexistent:${bin}`;
  d = await setup.claudeSetup({ ...NONE, tmux: () => '/usr/local/bin/tmux', app: () => '/Applications/Claude.app', terminal: () => true });
  assert.deepEqual(d.claude, { path: onPath, from: 'PATH' });
  assert.deepEqual([d.tmux.path, d.app.path, d.terminal.ok], ['/usr/local/bin/tmux', '/Applications/Claude.app', true]);
  // KB_CLAUDE_BIN goes first — and only a program that is there counts: the board takes the variable as written
  process.env.KB_CLAUDE_BIN = exe(join(tmp, 'my-claude'));
  assert.deepEqual((await setup.claudeSetup(NONE)).claude, { path: process.env.KB_CLAUDE_BIN, from: 'KB_CLAUDE_BIN' });
  process.env.KB_CLAUDE_BIN = join(tmp, 'gone-claude');
  assert.equal((await setup.claudeSetup(NONE)).claude.path, null, 'a KB_CLAUDE_BIN with nothing behind it passed for a program');
  delete process.env.KB_CLAUDE_BIN;
  // the Claude app is a macOS thing: elsewhere there is no row for it at all
  const linux = await setup.claudeSetup({ ...NONE, platform: 'linux', app: () => '/x/Claude.app' });
  assert.deepEqual(linux.app, { path: null, supported: false });
});

test('the Claude folder: which one, from which variable, and what the board reads in it', async () => {
  const missing = claudeFolder({ make: false });
  let d = await setup.claudeSetup(NONE);
  assert.deepEqual(d.folder, { path: missing, from: 'KB_CLAUDE_DIR', exists: false });
  assert.deepEqual([d.skill.exists, d.registry.exists, d.transcripts.exists], [false, false, false]);
  const viaConfig = claudeFolder({ via: 'CLAUDE_CONFIG_DIR' });
  assert.deepEqual((await setup.claudeSetup(NONE)).folder, { path: viaConfig, from: 'CLAUDE_CONFIG_DIR', exists: true });
  const home = claudeFolder({ via: 'default' });
  assert.deepEqual((await setup.claudeSetup(NONE)).folder, { path: home, from: 'default', exists: false });
  // KB_CLAUDE_DIR wins over CLAUDE_CONFIG_DIR
  const dir = claudeFolder();
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'elsewhere');
  assert.equal((await setup.claudeSetup(NONE)).folder.path, dir);
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(d.skill.state, 'missing');
  mkdirSync(join(dir, 'skills', 'kanban'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'kanban', 'SKILL.md'), '---\nname: kanban\n---\n');
  d = await setup.claudeSetup(NONE);
  assert.deepEqual([d.skill.exists, d.skill.symlink, d.skill.state], [true, false, 'differs']);
  const shipped = readFileSync(new URL('../skills/kanban/SKILL.md', import.meta.url));
  writeFileSync(join(dir, 'skills', 'kanban', 'SKILL.md'), shipped);
  writeFileSync(join(dir, 'skills', 'kanban', 'my-notes.md'), 'a file of the person\'s own does not make it differ');
  assert.equal((await setup.claudeSetup(NONE)).skill.state, 'same');
  rmSync(join(dir, 'skills', 'kanban'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../skills/kanban', import.meta.url)), join(dir, 'skills', 'kanban'));
  d = await setup.claudeSetup(NONE);
  assert.deepEqual([d.skill.exists, d.skill.symlink, d.skill.state], [true, true, 'same'], 'a clone\'s link to its own skills/ is not the board\'s version');
  rmSync(join(dir, 'skills', 'kanban'));
  mkdirSync(join(tmp, `own-kanban-${n}`));
  writeFileSync(join(tmp, `own-kanban-${n}`, 'SKILL.md'), '# my own version of the board\'s skill\n');
  symlinkSync(join(tmp, `own-kanban-${n}`), join(dir, 'skills', 'kanban'));
  assert.equal((await setup.claudeSetup(NONE)).skill.state, 'link', 'a version of the person\'s own behind a link is compared');
  // the registry of live sessions: two files, one of a process that runs (this one), one of a process long gone
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: '11111111-1111-4111-8111-111111111111', status: 'busy' }));
  writeFileSync(join(dir, 'sessions', '2.json'), JSON.stringify({ pid: 2 ** 30, sessionId: '22222222-2222-4222-8222-222222222222', status: 'idle' }));
  d = await setup.claudeSetup(NONE);
  assert.deepEqual([d.registry.exists, d.registry.sessions_n, d.registry.live_n], [true, 2, 1]);
  // the transcripts: a folder per project
  for (const p of ['-a', '-b']) mkdirSync(join(dir, 'projects', p), { recursive: true });
  writeFileSync(join(dir, 'projects', 'stray.txt'), 'x');
  d = await setup.claudeSetup(NONE);
  assert.deepEqual([d.transcripts.exists, d.transcripts.projects_n], [true, 2]);
});

test('when the limits came last: the proof the status line really runs', async () => {
  claudeFolder();
  assert.equal((await setup.claudeSetup(NONE)).limits.at, null);
  const now = Math.floor(Date.now() / 1000);
  limits.takeReading({ rate_limits: { five_hour: { used_percentage: 12, resets_at: now + 3600 } } });
  const at = (await setup.claudeSetup(NONE)).limits.at;
  assert.ok(Math.abs(Date.parse(at) - Date.now()) < 5000, `at: ${at}`);
});

test('settings.json: what connecting would change, each entry\'s state, whether it can be written', async () => {
  let dir = claudeFolder();
  let s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.exists, s.error, s.writable, s.seen, s.status_line, s.hook], [false, null, true, '', 'add', 'add']);
  assert.deepEqual(s.uninstall, []);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(OWN, null, 2));
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.status_line, s.hook], ['chain', 'add']);
  assert.match(s.seen, /^[0-9a-f]{64}$/);
  assert.equal(s.install.find((c) => c.part === 'statusLine').from, OWN.statusLine.command);
  // connected: both entries in place; taking off would give the person's status line back
  const kb = s.install.find((c) => c.part === 'statusLine').to.match(/^\{ (.*) statusline 2>\/dev\/null \|\| cat; \}/)[1];
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, kb).settings, null, 2));
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.status_line, s.hook], ['already', 'already']);
  assert.deepEqual(s.uninstall.map((c) => [c.part, c.action]), [['statusLine', 'restore'], ['PermissionRequest', 'remove']]);
  // the board's entries written with another node or another place of the board: they need connecting again
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, '/old/node /old/kb').settings, null, 2));
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.status_line, s.hook], ['update', 'update']);
  assert.equal(s.other_board, null, 'a board moved on the same port is called another board');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, hooks.kbCommand({ node: '/n', kb: '/kb', url: 'http://127.0.0.1:3999' })).settings, null, 2));
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.status_line, s.hook, s.other_board], ['update', 'update', 'http://127.0.0.1:3999']);
  // a status line the board does not change, a file that is not JSON, a read-only file, a folder that takes no file
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'static', text: 'x' } }));
  assert.equal((await setup.claudeSetup(NONE)).settings.status_line, 'skip');
  writeFileSync(join(dir, 'settings.json'), '{ "statusLine": ');
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.error, s.install], ['not-json', undefined]);
  writeFileSync(join(dir, 'settings.json'), '[1]');
  assert.equal((await setup.claudeSetup(NONE)).settings.error, 'not-object');
  writeFileSync(join(dir, 'settings.json'), '{}');
  chmodSync(join(dir, 'settings.json'), 0o444);
  s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.writable, s.why], [false, 'read-only']);
  dir = claudeFolder();
  chmodSync(dir, 0o555);
  try {
    s = (await setup.claudeSetup(NONE)).settings;
    assert.deepEqual([s.exists, s.writable, s.why], [false, false, 'folder']);
  } finally { chmodSync(dir, 0o755); }
});

// from 1.15.0, since connecting is asked for and never done by itself — and to one worked with only from the Claude
// app. The limits answer now says whether the status line goes through this board.
test('the limits answer says whether the status line goes through this board', async () => {
  const dir = claudeFolder();
  const link = async () => (await app.inject({ method: 'GET', url: '/api/limits' })).json().link;
  assert.equal(await link(), 'off', 'no settings.json');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(OWN, null, 2));
  assert.equal(await link(), 'off', 'a status line of the person\'s own, without the board');
  const s = (await setup.claudeSetup(NONE)).settings;
  const kb = s.install.find((c) => c.part === 'statusLine').to.match(/^\{ (.*) statusline 2>\/dev\/null \|\| cat; \}/)[1];
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, kb).settings, null, 2));
  assert.equal(await link(), 'connected');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, hooks.kbCommand({ node: '/n', kb: '/kb', url: 'http://127.0.0.1:3999' })).settings, null, 2));
  assert.equal(await link(), 'other');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks.planInstall(OWN, '/old/node /old/kb').settings, null, 2));
  assert.equal(await link(), 'off', 'written with paths that moved — it may not run');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'static', text: 'x' } }));
  assert.equal(await link(), 'manual', 'a status line Connect does not change is told to connect');
  writeFileSync(join(dir, 'settings.json'), '{ "statusLine": ');
  assert.equal(await link(), null);
  const j = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
  assert.ok('windows' in j && 'at' in j, 'the rest of the answer went away');
  // connecting tells every open tab at once: the event carries `link`
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(OWN, null, 2));
  const seen = [];
  const on = (e) => { if (e.type === 'limits.updated') seen.push(e.data); };
  const { bus } = await import('../src/bus.js');
  bus.on('event', on);
  try {
    const s2 = (await setup.claudeSetup(NONE)).settings;
    const r = await app.inject({ method: 'PUT', url: '/api/claude/hooks', headers: PAGE, payload: { seen: s2.seen } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(seen.map((d) => d.link), ['connected'], 'the footers of other tabs do not learn of the connection');
    const s3 = (await setup.claudeSetup(NONE)).settings;
    await app.inject({ method: 'PUT', url: '/api/claude/hooks', headers: PAGE, payload: { seen: s3.seen } });
    assert.equal(seen.length, 1, 'nothing written, and an event all the same');
  } finally { bus.off('event', on); }
});

// "Only looks": the check must not run claude (it would start a session), nor reach out to the network
test('checking starts nothing and sends nothing anywhere', async () => {
  claudeFolder();
  const marker = join(tmp, 'claude-was-run');
  const bin = join(tmp, 'spy-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho run > '${marker}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = bin;
  process.env.KB_CLAUDE_BIN = join(bin, 'claude');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (...a) => { fetched++; return realFetch(...a); };
  try {
    const r = await app.inject({ method: 'GET', url: '/api/claude' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().claude.path, join(bin, 'claude'));
  } finally { globalThis.fetch = realFetch; delete process.env.KB_CLAUDE_BIN; }
  assert.ok(!existsSync(marker), 'the check ran claude');
  assert.equal(fetched, 0, 'the check went to the network');
});

test('GET /api/claude answers everything at once, in the shape the page reads', async () => {
  claudeFolder();
  const d = (await app.inject({ method: 'GET', url: '/api/claude' })).json();
  assert.deepEqual(Object.keys(d).sort(), ['app', 'claude', 'folder', 'limits', 'platform', 'registry', 'settings', 'skill', 'terminal', 'tmux', 'transcripts', 'env', 'macos'].sort());
  assert.deepEqual(Object.keys(d.env).sort(), ['keys', 'settings', 'taken_off']);
  assert.deepEqual(Object.keys(d.registry).sort(), ['exists', 'live_n', 'path', 'sessions_n']);
  assert.deepEqual(Object.keys(d.transcripts).sort(), ['exists', 'path', 'projects_n']);
});

const put = (seen, headers = PAGE, method = 'PUT') => app.inject({ method, url: '/api/claude/hooks', headers, payload: seen === undefined ? {} : { seen } });
const seenNow = async () => (await app.inject({ method: 'GET', url: '/api/claude' })).json().settings.seen;
const copies = () => { const d = join(process.env.KB_DATA_DIR, 'backups', 'claude-settings'); return existsSync(d) ? readdirSync(d) : []; };

test('connecting from the page: the change agreed to on screen, the layout kept, a .json copy, and back byte for byte', async () => {
  const dir = claudeFolder();
  const file = join(dir, 'settings.json');
  const original = `${JSON.stringify(OWN, null, '\t')}\n`;
  writeFileSync(file, original);
  const before = copies().length;
  assert.equal((await put(await seenNow(), {})).statusCode, 403, 'connected without the board page');
  assert.equal((await put(await seenNow(), { 'sec-fetch-site': 'same-origin' })).statusCode, 403);
  assert.equal((await put(undefined)).statusCode, 400, 'written without the fingerprint of what was shown');
  assert.equal(readFileSync(file, 'utf8'), original, 'a refused request changed the file');
  // the file changed while the page showed the change (Claude Code wrote /config meanwhile): not written over
  const stale = await seenNow();
  writeFileSync(file, `${JSON.stringify({ ...OWN, model: 'sonnet' }, null, '\t')}\n`);
  const r1 = await put(stale);
  assert.deepEqual([r1.statusCode, r1.json().reason], [409, 'changed']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).model, 'sonnet', 'the change Claude Code made meanwhile was lost');
  writeFileSync(file, original);
  const r2 = await put(await seenNow());
  assert.equal(r2.statusCode, 200, r2.body);
  const ok = r2.json();
  assert.equal(ok.written, true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(hooks.isOurs(s.statusLine.command, 'statusline') && s.statusLine.command.endsWith(`| {\n${OWN.statusLine.command}\n}`));
  assert.ok(hooks.isOurs(s.hooks.PermissionRequest[0].hooks[0].command, 'hook'));
  assert.ok(readFileSync(file, 'utf8').includes('\n\t"statusLine"'), 'the file lost its tab indent');
  assert.equal(copies().length, before + 1, 'no copy of the previous file');
  assert.match(ok.kept, /settings-.*\.json$/);
  assert.equal(readFileSync(ok.kept, 'utf8'), original);
  // connected already: nothing to write, nothing copied
  const again = (await put(await seenNow())).json();
  assert.deepEqual([again.ok, again.written], [true, false]);
  assert.equal(copies().length, before + 1);
  // taking it off gives the file back byte for byte
  const off = await put(await seenNow(), PAGE, 'DELETE');
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(readFileSync(file, 'utf8'), original, 'taking off did not give the file back');
});

test('connecting from the page refuses a file it must not write, and says why', async () => {
  const dir = claudeFolder();
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{ "statusLine": ');
  const bad = await put('');
  assert.deepEqual([bad.statusCode, bad.json().reason], [409, 'not-json']);
  assert.equal(readFileSync(file, 'utf8'), '{ "statusLine": ');
  writeFileSync(file, JSON.stringify(OWN, null, 2));
  chmodSync(file, 0o444);
  const ro = await put(await seenNow());
  assert.deepEqual([ro.statusCode, ro.json().reason], [409, 'read-only']);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(OWN, null, 2), 'a read-only settings.json was replaced through its folder');
  chmodSync(file, 0o644);
  // no copy can be kept (the data folder takes no file): nothing is written
  const backups = join(process.env.KB_DATA_DIR, 'backups', 'claude-settings');
  mkdirSync(backups, { recursive: true });
  chmodSync(backups, 0o555);
  try {
    const nocopy = await put(await seenNow());
    assert.deepEqual([nocopy.statusCode, nocopy.json().reason], [500, 'no-copy']);
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify(OWN, null, 2), 'written without a copy of the previous file');
  } finally { chmodSync(backups, 0o755); }
  // a new file in an empty Claude folder: created, nothing to copy
  const fresh = claudeFolder();
  const made = await put('');
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().kept, null);
  assert.ok(hooks.isOurs(JSON.parse(readFileSync(join(fresh, 'settings.json'), 'utf8')).statusLine.command, 'statusline'));
});

// What the section says — public/js/claude-setup-rules.js, a leaf run here in node.
const ALL = {
  platform: 'darwin',
  claude: { path: '/opt/homebrew/bin/claude', from: 'PATH' }, tmux: { path: '/opt/homebrew/bin/tmux' },
  app: { path: '/Applications/Claude.app', supported: true }, terminal: { ok: true, how: 'Terminal' },
  folder: { path: '/home/user/.claude', from: 'default', exists: true },
  skill: { path: '/home/user/.claude/skills/kanban/SKILL.md', exists: true, symlink: false },
  registry: { exists: true, sessions_n: 3, live_n: 1 }, transcripts: { exists: true, projects_n: 12 },
  limits: { at: '2026-10-06T07:00:00.000Z', fresh: true },
  settings: { path: '/home/user/.claude/settings.json', exists: true, error: null, writable: true, why: null, seen: 'abc',
    status_line: 'already', hook: 'already', install: [{ part: 'statusLine', action: 'already' }, { part: 'PermissionRequest', action: 'already' }],
    uninstall: [{ part: 'statusLine', action: 'restore', from: 'kb', to: 'mine' }, { part: 'PermissionRequest', action: 'remove' }] },
};
const NOTHING = {
  platform: 'darwin', claude: { path: null, from: 'PATH' }, tmux: { path: null }, app: { path: null, supported: true }, terminal: { ok: true },
  folder: { path: '/home/user/.claude', from: 'default', exists: false }, skill: { exists: false }, registry: { exists: false, sessions_n: 0, live_n: 0 },
  transcripts: { exists: false, projects_n: 0 }, limits: { at: null },
  settings: { path: '/home/user/.claude/settings.json', exists: false, error: null, writable: true, why: null, seen: '', status_line: 'add', hook: 'add',
    install: [{ part: 'statusLine', action: 'add', to: 'kb statusline --line' }, { part: 'PermissionRequest', action: 'add', to: 'kb hook permission' }], uninstall: [] },
};
const rows = (view) => Object.fromEntries(view.flatMap((g) => g.rows).map((r) => [r.id, r]));

test('the section: every piece there is a ✓, every piece missing says what does not work and how to fix it', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  const all = r.setupView(ALL);
  assert.deepEqual(all.map((g) => g.id), ['programs', 'folder', 'connection']);
  assert.deepEqual(Object.entries(rows(all)).map(([id, x]) => [id, x.state]),
    ['claude', 'tmux', 'app', 'terminal', 'folder', 'skill', 'registry', 'transcripts', 'statusline', 'hook', 'limits'].map((id) => [id, 'ok']));
  assert.deepEqual(rows(all).registry.count, { n: 1, label: 'running now' });
  assert.deepEqual(rows(all).transcripts.count, { n: 12, label: 'projects' });
  assert.equal(rows(all).limits.value, ALL.limits.at);
  assert.match(rows(all).statusline.note, /in front of your own/, 'the chained status line is not called so');
  const none = rows(r.setupView(NOTHING));
  for (const id of ['claude', 'folder', 'skill']) assert.equal(none[id].state, 'off', id);
  for (const id of ['tmux', 'app', 'registry', 'transcripts', 'statusline', 'hook', 'limits']) assert.equal(none[id].state, 'opt', id);
  assert.equal(rows(r.setupView({ ...NOTHING, app: { path: '/Applications/Claude.app', supported: true } })).claude.state, 'opt',
    'without the program the Claude app still starts tasks — that is no ✕');
  assert.deepEqual(none.claude.fix, { cmd: r.INSTALL_CLAUDE_CMD, href: r.INSTALL_CLAUDE_URL, label: 'How to install Claude Code' });
  assert.match(r.INSTALL_CLAUDE_URL, /^https:\/\/code\.claude\.com\/docs\//);
  assert.deepEqual(none.tmux.fix, { cmd: 'brew install tmux' });
  assert.deepEqual(none.app.fix, { href: r.CLAUDE_APP_URL, label: 'Download the Claude app' });
  assert.deepEqual(none.skill.fix, { section: 'skills', label: 'Install it in Skills' });
  assert.deepEqual([none.statusline.fix, none.hook.fix], [{ connect: true }, { connect: true }]);
  for (const id of Object.keys(none)) assert.ok(/^Not |^No |^None /.test(none[id].note) || id === 'terminal', `${id}: "${none[id].note}" does not say what is missing`);
  // elsewhere than macOS: no brew, no Claude app row, a terminal of its own
  const linux = rows(r.setupView({ ...NOTHING, platform: 'linux', app: { path: null, supported: false }, terminal: { ok: false } }));
  assert.equal(linux.app, undefined, 'the Claude app is offered where it does not exist');
  assert.equal(linux.tmux.fix.cmd, undefined, 'a Homebrew command offered off macOS');
  assert.equal(linux.terminal.state, 'opt');
  // the folder: where it comes from, and a folder KB_CLAUDE_DIR points at that does not exist
  assert.match(rows(r.setupView({ ...ALL, folder: { ...ALL.folder, from: 'KB_CLAUDE_DIR' } })).folder.note, /KB_CLAUDE_DIR/);
  assert.match(rows(r.setupView({ ...ALL, folder: { ...ALL.folder, from: 'CLAUDE_CONFIG_DIR' } })).folder.note, /CLAUDE_CONFIG_DIR/);
  assert.match(rows(r.setupView({ ...NOTHING, folder: { ...NOTHING.folder, from: 'KB_CLAUDE_DIR' } })).folder.fix.text, /KB_CLAUDE_DIR/);
  assert.match(rows(r.setupView({ ...ALL, claude: { path: '/x/c', from: 'KB_CLAUDE_BIN' } })).claude.note, /KB_CLAUDE_BIN/);
  assert.match(rows(r.setupView({ ...ALL, skill: { ...ALL.skill, symlink: true } })).skill.note, /link/);
  const old = rows(r.setupView({ ...ALL, skill: { ...ALL.skill, state: 'differs' } })).skill;
  assert.deepEqual([old.state, old.fix], ['warn', { section: 'skills', label: 'Update it in Skills' }]);
  assert.match(old.note, /^Not the version this board ships/);
  for (const state of ['same', 'link', undefined]) assert.equal(rows(r.setupView({ ...ALL, skill: { ...ALL.skill, state } })).skill.state, 'ok', String(state));
});

test('the connection: each state of the two entries, the limits, a broken file', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  const at = (status_line, hook, extra = {}) => rows(r.setupView({ ...ALL, settings: { ...ALL.settings, status_line, hook, uninstall: [] }, ...extra }));
  const upd = at('update', 'update');
  assert.deepEqual([upd.statusline.state, upd.hook.state, upd.statusline.fix, upd.hook.fix], ['warn', 'warn', { connect: true }, { connect: true }]);
  const skip = at('skip', 'skip');
  assert.deepEqual([skip.statusline.state, skip.hook.state], ['warn', 'warn']);
  assert.equal(skip.statusline.fix.href, r.README_HOOKS_URL, 'a status line the board cannot change has no way out');
  assert.match(r.README_HOOKS_URL, /^https:\/\/github\.com\/.*#connect-the-board-to-claude-code/);
  assert.deepEqual([at('chain', 'add').statusline.state, at('chain', 'add').hook.state], ['opt', 'opt']);
  // through the board — the limits row waits for a reading instead of saying none can come
  const odd = rows(r.setupView({ ...ALL, limits: { at: null }, settings: { ...ALL.settings, status_line: 'skip', hook: 'already', uninstall: [],
    install: [{ part: 'statusLine', action: 'skip', ours: true }, { part: 'PermissionRequest', action: 'already' }] } }));
  assert.equal(odd.statusline.state, 'warn');
  assert.match(odd.statusline.note, /^Goes through the board, but/, 'the board\'s own status line called someone else\'s');
  assert.equal(odd.statusline.fix.href, r.README_HOOKS_URL);
  assert.equal(odd.limits.state, 'warn', 'a status line that goes through the board is said to send no limits');
  const taken = rows(r.setupView({ ...ALL, settings: { ...ALL.settings, status_line: 'update', hook: 'update', other_board: 'http://127.0.0.1:3101', uninstall: [] } }));
  for (const id of ['statusline', 'hook']) {
    assert.deepEqual([taken[id].state, taken[id].value, taken[id].fix], ['warn', 'http://127.0.0.1:3101', { connect: true }], id);
    assert.match(taken[id].note, /^Connected to another board/, `${id}: another board's entry called a moved one`);
  }
  const older = rows(r.setupView({ ...ALL, settings: { ...ALL.settings, status_line: 'already', hook: 'update', uninstall: [],
    install: [{ part: 'statusLine', action: 'already' }, { part: 'PermissionRequest', action: 'update', older: true }] } }));
  assert.deepEqual([older.hook.state, older.hook.fix], ['ok', { connect: true }]);
  assert.match(older.hook.note, /^Come to the card of the task\. Written by an earlier version of the board/, 'an older form called a moved board');
  assert.equal(upd.hook.state, 'warn', 'a moved board called only an older form');
  assert.doesNotMatch(at('already', 'already').statusline.note, /in front of your own/, 'a status line of the board alone called chained');
  // the limits: a reading — it runs; none with the status line connected — not yet; none without — it cannot come
  assert.equal(at('already', 'already', { limits: { at: null } }).limits.state, 'warn');
  assert.equal(at('chain', 'add', { limits: { at: null } }).limits.state, 'opt');
  for (const error of ['not-json', 'not-object', 'unreadable']) {
    const v = r.setupView({ ...ALL, settings: { path: '/s', exists: true, error } });
    assert.deepEqual(v[2].rows.map((x) => [x.id, x.state]), [['settings', 'warn']], error);
  }
});

test('the buttons, the confirmation and the refusals', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  assert.deepEqual(r.hooksButtons(ALL.settings), { connect: false, disconnect: true, why: null });
  assert.deepEqual(r.hooksButtons(NOTHING.settings), { connect: true, disconnect: false, why: null });
  for (const error of ['not-json', 'not-object', 'unreadable']) {
    const b = r.hooksButtons({ error });
    assert.deepEqual([b.connect, b.disconnect, typeof b.why], [false, false, 'string'], error);
  }
  assert.match(r.hooksButtons({ ...NOTHING.settings, writable: false, why: 'read-only' }).why, /read-only/);
  assert.match(r.hooksButtons({ ...NOTHING.settings, writable: false, why: 'folder' }).why, /folder/);
  assert.equal(r.hooksButtons({ ...NOTHING.settings, writable: false }).connect, false, 'a read-only file offered to be connected');
  assert.deepEqual(r.changeLines([
    { part: 'statusLine', action: 'add', to: 'kb statusline --line' }, { part: 'PermissionRequest', action: 'already' },
    { part: 'statusLine', action: 'chain', from: 'mine', to: '{ kb statusline || cat; } | {\nmine\n}' },
    { part: 'PermissionRequest', action: 'remove' }, { part: 'statusLine', action: 'restore', from: 'kb', to: 'mine' }]),
  ['+ statusLine: kb statusline --line', '~ statusLine: mine\n  → { kb statusline || cat; } | {\nmine\n}', '- PermissionRequest', '~ statusLine: kb\n  → mine']);
  assert.match(r.hooksRefusal({ offline: true }), /No connection/);
  assert.match(r.hooksRefusal({ status: 409, body: { reason: 'changed' } }), /changed since/);
  assert.match(r.hooksRefusal({ status: 409, body: { reason: 'read-only' } }), /read-only/);
  assert.match(r.hooksRefusal({ status: 500, body: { reason: 'no-copy' } }), /copy/);
  assert.match(r.hooksRefusal({ status: 409, body: { reason: 'not-json' } }), /^Nothing was written/);
  assert.match(r.hooksRefusal({ status: 500, body: {} }), /Could not write/);
});

test('every word of the section has its Russian line, and the launch settings moved out of General', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  const texts = new Set();
  const views = [ALL, NOTHING, { ...NOTHING, platform: 'linux', app: { supported: false }, terminal: { ok: false } },
    ...['KB_CLAUDE_DIR', 'CLAUDE_CONFIG_DIR', 'default'].flatMap((from) => [{ ...ALL, folder: { ...ALL.folder, from } }, { ...NOTHING, folder: { ...NOTHING.folder, from } }]),
    { ...ALL, claude: { path: '/x', from: 'KB_CLAUDE_BIN' } }, { ...ALL, skill: { ...ALL.skill, symlink: true } },
    { ...ALL, skill: { ...ALL.skill, state: 'differs' } }, { ...NOTHING, app: { path: '/A', supported: true } },
    ...[{ taken_off: ['CLAUDE_CODE_SIMPLE'] }, { settings: ['CLAUDE_CODE_SIMPLE', 'ANTHROPIC_AUTH_TOKEN'] }, { keys: ['ANTHROPIC_API_KEY'] }, { keys: ['ANTHROPIC_AUTH_TOKEN'] }, { settings: ['ANTHROPIC_API_KEY'] }].map((env) => ({ ...ALL, env })),
    ...['already', 'update', 'chain', 'skip', 'add'].flatMap((sl) => ['already', 'update', 'skip', 'add'].flatMap((hook) => [null, 'x'].map((t) => ({ ...ALL, limits: { at: t }, settings: { ...ALL.settings, status_line: sl, hook, uninstall: [] } })))),
    ...['not-json', 'not-object', 'unreadable'].map((error) => ({ ...ALL, settings: { error } })),
    { ...ALL, settings: { ...ALL.settings, status_line: 'skip', install: [{ part: 'statusLine', action: 'skip', ours: true }], uninstall: [] } },
    { ...ALL, settings: { ...ALL.settings, status_line: 'update', hook: 'update', other_board: 'http://127.0.0.1:3101', uninstall: [] } },
    { ...ALL, settings: { ...ALL.settings, hook: 'update', install: [{ part: 'PermissionRequest', action: 'update', older: true }], uninstall: [] } },
    ...[true, false].flatMap((full_disk) => [true, false].map((pm2) => ({ ...ALL, macos: { node: '/n', full_disk, pm2 } })))];
  for (const v of views) for (const g of r.setupView(v)) {
    texts.add(g.title);
    for (const x of g.rows) for (const t of [x.title, x.note, x.fix?.label, x.fix?.text, x.count?.label]) if (t) texts.add(t);
  }
  for (const s of [{ error: 'not-json' }, { error: 'x' }, { writable: false, why: 'folder' }, { writable: false, why: 'read-only' }, { writable: false, why: 'no-folder' }]) texts.add(r.hooksButtons(s).why);
  for (const e of [{ offline: true }, ...['changed', 'read-only', 'folder', 'no-folder', 'no-copy', 'not-json', 'not-object', 'unreadable', 'x'].map((reason) => ({ body: { reason } }))]) texts.add(r.hooksRefusal(e));
  for (const on_path of ['/usr/bin/claude', null]) for (const v of r.setupView({ ...ALL, claude: { path: null, from: 'KB_CLAUDE_BIN', set: '/x', on_path } })) for (const x of v.rows) [x.note, x.fix?.text].forEach((t) => t && texts.add(t));
  for (const v of [{ ...ALL, limits: { at: 'x', fresh: false } }, { ...ALL, limits: { at: 'x', fresh: true }, settings: { ...ALL.settings, status_line: 'add' } }]) for (const g of r.setupView(v)) for (const x of g.rows) texts.add(x.note);
  const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
  const core = read('core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const SAME = new Set(['Claude Code (claude)', 'tmux', 'settings.json']); // names, the same on a Russian board
  const has = (t) => dict.includes(`'${t}':`) || dict.includes(`"${t}":`) || dict.includes(`\n  ${t}:`);
  const missing = [...texts].filter((t) => !SAME.has(t) && !has(t));
  assert.deepEqual(missing, [], 'stays English on the Russian board');
  // the page words of the section itself
  const settings = read('settings.js');
  // bounded by code, not by comments: the published copy has its comments stripped
  const page = [...settings.slice(settings.indexOf('const CC_MARK'), settings.indexOf('let skillSel = null;')).matchAll(/tr\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(page.length > 10 && settings.indexOf('let skillSel = null;') > settings.indexOf('const CC_MARK'), 'the section\'s words were not found');
  assert.deepEqual(page.filter((t) => !has(t)), [], 'stays English on the Russian board');
  // the words of the marks go through tr() as values, not as literals the line above finds
  const marks = [...settings.slice(settings.indexOf('const CC_MARK'), settings.indexOf('\n', settings.indexOf('const CC_MARK'))).matchAll(/\['[^']+', '([^']+)'\]/g)].map((m) => m[1]);
  assert.deepEqual(marks.length, 4, `the marks were not found: ${marks}`);
  assert.deepEqual(marks.filter((t) => !has(t)), [], 'a mark stays English on the Russian board');
  // «Start tasks» and «Claude inside the board may» live in the Claude Code section now, and only there
  const general = settings.slice(settings.indexOf("if (sec === 'general')"), settings.indexOf("} else if (sec === 'appearance')"));
  assert.ok(!/sel-launch|sel-permission/.test(general), 'the launch settings are still in General');
  const section = settings.slice(settings.indexOf('async function renderClaudeSection'), settings.indexOf('async function loadClaude'));
  assert.ok(/id="sel-launch"/.test(section) && /id="sel-permission"/.test(section), 'the launch settings are not in the Claude Code section');
  assert.match(settings, /\['claude', 'Claude Code'\], \['skills', tr\('Skills'\)\]/, 'the section does not stand next to Skills');
});

// The page's part of connecting (changeClaudeHooks in public/js/settings.js) is held by none of the checks above: the
// rules and the routes are, but not that a declined confirmation writes nothing, that the confirmation shows the
// change, that the consent carries the fingerprint of what was shown, and that a refusal is said in the board's words.
// lives in the browser; here, as for the other checks of the page, the form of the code.
test('the page writes only on a yes: the confirmation shows the change, the consent carries what was shown, a refusal is in the board\'s words', () => {
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = src.slice(src.indexOf('async function changeClaudeHooks'), src.indexOf('let skillSel = null;'));
  assert.ok(fn.startsWith('async function changeClaudeHooks') && fn.length < 3000, 'changeClaudeHooks was not found in public/js/settings.js');
  const at = (re, what) => { const m = re.exec(fn); assert.ok(m, what); return m.index; };
  const asked = at(/const ok = await styledConfirm\(/, 'connecting is not confirmed');
  at(/detail: `\$\{s\.path\}\\n\\n\$\{lines\.join\('\\n'\)\}/, 'the confirmation does not show what will be written');
  const declined = at(/\n\s*if \(!ok\) return;/, 'a declined confirmation does not stop the change');
  const sent = at(/await api\(install \? 'PUT' : 'DELETE', '\/api\/claude\/hooks', \{ seen: s\.seen \}/, 'the consent does not carry the fingerprint of the file it was given for');
  assert.ok(asked < declined && declined < sent, 'the change goes out before the answer to the confirmation is looked at');
  assert.match(fn, /catch \(e\) \{ note = \{ text: tr\(hooksRefusal\(e\)\), bad: true \}; \}/, 'a refusal is shown in the server\'s words, not in the board\'s');
  assert.ok(at(/\n\s*loadLimits\(\);/, 'the footer of the limits is not read again after connecting') > sent, 'the footer is read again before the change is made');
});

// are first. The real changeClaudeHooks runs on stubs and is declined, so nothing is sent.
test('the confirmation names the other board before taking it over or off', async () => {
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8');
  const at = src.indexOf('async function changeClaudeHooks(');
  assert.ok(at > 0, 'changeClaudeHooks was not found in public/js/settings.js');
  const asked = [];
  const box = {
    tr: (t) => t, changeLines: () => ['~ x'], $: () => null, hooksRefusal: () => '', loadClaude: async () => {},
    styledConfirm: async (msg) => { asked.push(msg); return false; },
    api: async () => { throw new Error('written without consent'); },
  };
  vm.runInNewContext(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.run = changeClaudeHooks;`, box);
  const s = { path: '/s', exists: true, seen: 'f', install: [{}], uninstall: [{}] };
  await box.run('install', { ...s, other_board: 'http://127.0.0.1:3101' });
  await box.run('uninstall', { ...s, other_board: 'http://127.0.0.1:3101' });
  await box.run('install', { ...s, other_board: null });
  assert.deepEqual(asked, [
    'Another board is connected to Claude Code: http://127.0.0.1:3101. Take it over and connect this one?',
    'Another board is connected to Claude Code: http://127.0.0.1:3101. Take it off Claude Code?',
    'Connect the board to Claude Code?',
  ]);
});

test('CK-548: a folder KB_CLAUDE_DIR names that is not there — no Connect, and the route makes neither it nor settings.json', async () => {
  const dir = claudeFolder({ make: false });
  const s = (await setup.claudeSetup(NONE)).settings;
  assert.deepEqual([s.writable, s.why], [false, 'no-folder']);
  const r = await app.inject({ method: 'PUT', url: '/api/claude/hooks', headers: PAGE, payload: { seen: s.seen } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().reason, 'no-folder');
  assert.match(r.json().error, /KB_CLAUDE_DIR/);
  assert.ok(!existsSync(dir), 'the board made the folder KB_CLAUDE_DIR names');
  // the same folder named by CLAUDE_CONFIG_DIR, or the default one: Claude Code has not run yet — that is no mistake
  claudeFolder({ make: false, via: 'CLAUDE_CONFIG_DIR' });
  assert.equal((await setup.claudeSetup(NONE)).settings.why, null);
});

test('CK-548: a Claude folder that is not writable over a writable settings.json — no Connect, a refusal by name, no copy per try', async () => {
  const dir = claudeFolder();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(OWN, null, 2));
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const s = (await setup.claudeSetup(NONE)).settings;
  chmodSync(dir, 0o555);
  const kept = join(process.env.KB_DATA_DIR, 'backups', 'claude-settings');
  const copies = () => (existsSync(kept) ? readdirSync(kept).length : 0);
  const was = copies();
  try {
    assert.deepEqual([(await setup.claudeSetup(NONE)).settings.writable, (await setup.claudeSetup(NONE)).settings.why], [false, 'folder']);
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: 'PUT', url: '/api/claude/hooks', headers: PAGE, payload: { seen: s.seen } });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().reason, 'folder');
    }
  } finally { chmodSync(dir, 0o755); }
  assert.equal(copies(), was, 'a copy of settings.json was kept for every refused try');
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), before);
});

test('CK-548: KB_CLAUDE_BIN that points where there is no program is the variable\'s fault, not an install to make', async () => {
  claudeFolder();
  const bin = join(tmp, 'bin-548'); mkdirSync(bin, { recursive: true });
  exe(join(bin, 'claude'));
  process.env.PATH = bin;
  process.env.KB_CLAUDE_BIN = join(tmp, 'no-such', 'claude');
  try {
    const d = await setup.claudeSetup(NONE);
    assert.deepEqual(d.claude, { path: null, from: 'KB_CLAUDE_BIN', set: join(tmp, 'no-such', 'claude'), on_path: join(bin, 'claude') });
    const r = await import('../public/js/claude-setup-rules.js');
    const row = rows(r.setupView({ ...ALL, ...d, app: { path: null, supported: true } })).claude;
    assert.equal(row.state, 'off');
    assert.match(row.note, /^KB_CLAUDE_BIN points where there is no program/);
    assert.equal(row.value, join(tmp, 'no-such', 'claude'));
    assert.equal(row.fix.href, undefined, 'it sends the person to install Claude Code, which is on PATH');
    assert.match(row.fix.text, /remove it — then the board takes claude from PATH/);
    assert.match(rows(r.setupView({ ...ALL, claude: { ...d.claude, on_path: null } })).claude.fix.text, /point it at the claude program/);
  } finally { delete process.env.KB_CLAUDE_BIN; }
});

test('CK-548: "the status line runs" only for a fresh reading while it goes through the board', async () => {
  claudeFolder();
  const now = Date.now();
  limits.takeReading({ rate_limits: { five_hour: { used_percentage: 12, resets_at: now / 1000 + 3600 } } }, now - 6 * 3600 * 1000);
  assert.equal((await setup.claudeSetup(NONE)).limits.fresh, false, 'a reading six hours old is fresh');
  limits.takeReading({ rate_limits: { five_hour: { used_percentage: 13, resets_at: now / 1000 + 3600 } } }, now);
  assert.equal((await setup.claudeSetup(NONE)).limits.fresh, true);
  const r = await import('../public/js/claude-setup-rules.js');
  const lim = (fresh, status_line) => rows(r.setupView({ ...ALL, limits: { at: ALL.limits.at, fresh }, settings: { ...ALL.settings, status_line, uninstall: [] } })).limits;
  assert.equal(lim(true, 'already').state, 'ok');
  for (const [fresh, sl] of [[false, 'already'], [true, 'add'], [true, 'chain'], [true, 'update']]) {
    const x = lim(fresh, sl);
    assert.notEqual(x.state, 'ok', `${fresh} ${sl}`);
    assert.doesNotMatch(x.note, /it runs/, `${fresh} ${sl}: says the status line runs`);
    assert.equal(x.value, ALL.limits.at, 'the time of the last reading is gone');
  }
  // a broken settings.json, or none at all in a folder that is not there: no connection — and no "it runs" either
  assert.equal(rows(r.setupView({ ...NOTHING, limits: { at: ALL.limits.at, fresh: true } })).limits.state, 'opt');
});

test('CK-548: one refusal is said once — no second plate under the buttons, no third copy of the file\'s own words', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8');
  const a = src.indexOf('let claudeSeq = 0;');
  const b = src.indexOf('async function renderClaudeSection');
  const c = src.indexOf('async function loadClaude(');
  const e = src.indexOf('\n}\n', c) + 2;
  assert.ok(a > 0 && b > a && c > b && e > c, 'the section\'s code was not found in public/js/settings.js');
  const el = () => ({ innerHTML: '', textContent: '', className: '', disabled: false, onclick: null, scrollIntoView() {}, querySelectorAll: () => [] });
  const page = (answer) => {
    const els = { 'cc-list': el(), 'cc-done': null, 'cc-connect': el(), 'cc-disconnect': el() };
    const box = {
      tr: (t) => t, esc: (t) => String(t), fmtLocalStamp: (t) => t, setupView: r.setupView, hooksButtons: r.hooksButtons,
      $: (id) => els[id], document: { querySelector: () => null }, CSS: { escape: (x) => x }, changeClaudeHooks: () => {},
      api: async () => { if (answer instanceof Error) throw answer; return answer; },
    };
    vm.runInNewContext(`${src.slice(a, b)}\n${src.slice(c, e)}\nthis.load = loadClaude;`, box);
    return { els, load: box.load };
  };
  const plates = (html) => (html.match(/kbh-note warn/g) || []).length;
  const words = (html, t) => html.split(t).length - 1;
  // a file that is not JSON: its own row says it — the buttons' reason and the refusal do not repeat it
  const broken = { ...ALL, settings: { path: '/s', exists: true, error: 'not-json' } };
  let p = page(broken);
  const refusal = r.hooksRefusal({ body: { reason: 'not-json' } });
  await p.load({ text: refusal, bad: true });
  const said = 'settings.json is not valid JSON — the board does not touch it. Fix the file, then check again.';
  assert.equal(words(p.els['cc-list'].innerHTML, said), 1, `said ${words(p.els['cc-list'].innerHTML, said)} times`);
  assert.equal(plates(p.els['cc-list'].innerHTML), 1, 'more than one plate under the buttons');
  // a read-only file refused on the click: one plate, the refusal's
  p = page({ ...ALL, settings: { ...NOTHING.settings, writable: false, why: 'read-only' } });
  await p.load({ text: r.hooksRefusal({ body: { reason: 'read-only' } }), bad: true });
  assert.equal(plates(p.els['cc-list'].innerHTML), 1, 'two near-identical yellow plates');
  // without a click, the reason stands under the buttons — KB_CLAUDE_DIR at a folder that is not there among them
  p = page({ ...ALL, settings: { ...NOTHING.settings, writable: false, why: 'no-folder' } });
  await p.load();
  assert.match(p.els['cc-list'].innerHTML, /No such folder — check KB_CLAUDE_DIR/);
  assert.match(p.els['cc-list'].innerHTML, /id="cc-connect" disabled/, 'Connect is offered for a folder that is not there');
});

test('CK-548: no connection after a click keeps the list and says nothing was written; a double click opens one confirmation', async () => {
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8');
  const a = src.indexOf('let claudeSeq = 0;');
  const c = src.indexOf('async function loadClaude(');
  const e = src.indexOf('\n}\n', c) + 2;
  const els = { 'cc-list': { innerHTML: '<div class="cc-row">the list</div>' }, 'cc-done': { textContent: '', className: 'cc-done muted hidden', scrollIntoView() {} },
    'cc-connect': { disabled: true }, 'cc-disconnect': { disabled: true } };
  const off = Object.assign(new Error('offline'), { offline: true });
  const box = { tr: (t) => t, esc: (t) => t, $: (id) => els[id], api: async () => { throw off; } };
  vm.runInNewContext(`${src.slice(a, a + 'let claudeSeq = 0;'.length)}\n${src.slice(c, e)}\nthis.load = loadClaude;`, box);
  box.load.buttons = { 'cc-connect': true, 'cc-disconnect': false };
  await box.load({ text: 'No connection to the board — nothing was written. Try again.', bad: true });
  assert.equal(els['cc-list'].innerHTML, '<div class="cc-row">the list</div>', 'the list was replaced by "no connection"');
  assert.equal(els['cc-done'].textContent, 'No connection to the board — nothing was written. Try again.');
  assert.match(els['cc-done'].className, /warn/);
  assert.doesNotMatch(els['cc-done'].className, /hidden/);
  assert.deepEqual([els['cc-connect'].disabled, els['cc-disconnect'].disabled], [false, true], 'the buttons stay as they were before the click');
  // failed check follows it, and the buttons of the file before the connect wait for «Check again»
  await box.load({ text: 'Connected ✓', bad: false });
  assert.equal(els['cc-done'].textContent, 'Connected ✓ No connection to the board — try again');
  assert.deepEqual([els['cc-connect'].disabled, els['cc-disconnect'].disabled], [true, true], 'Connect offers the change it has just made');
  // "Check again" without a connection, the list on screen: kept too
  await box.load();
  assert.equal(els['cc-list'].innerHTML, '<div class="cc-row">the list</div>');
  assert.equal(els['cc-done'].textContent, 'No connection to the board — try again');
  // the first opening of the section without a connection: nothing to keep — the list says it
  els['cc-done'] = null;
  await box.load();
  assert.match(els['cc-list'].innerHTML, /No connection to the board/);

  // a double click: the second click while the first one's confirmation is open asks nothing more
  const at = src.indexOf('async function changeClaudeHooks(');
  const answers = [];
  const asked = [];
  const hb = {
    tr: (t) => t, changeLines: () => ['~ x'], $: () => null, hooksRefusal: () => '', loadClaude: async () => {}, loadLimits: () => {},
    styledConfirm: (msg) => { asked.push(msg); return new Promise((res) => { answers.push(res); }); },
    api: async () => ({ written: true }),
  };
  vm.runInNewContext(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.run = changeClaudeHooks;`, hb);
  const s = { path: '/s', exists: true, seen: 'f', install: [{}], uninstall: [{}] };
  const first = hb.run('install', s);
  const second = hb.run('install', s);
  await Promise.resolve();
  const n = asked.length;
  answers.forEach((res) => res(false));
  await Promise.all([first, second]);
  assert.equal(n, 1, 'the second click opened a second confirmation');
  const third = hb.run('install', s);
  assert.equal(asked.length, 2, 'after the answer the button does nothing any more');
  answers.forEach((res) => res(false));
  await third;
});

test('CK-548: a click on the backdrop right after the confirmation opened — the second of a double click — does not cancel it', () => {
  const src = readFileSync(fileURLToPath(new URL('../public/js/sidebar.js', import.meta.url)), 'utf8');
  const at = src.indexOf('export function styledConfirm(');
  const fn = src.slice(at, src.indexOf('\n}\n', at) + 2).replace('export function', 'function');
  const node = () => ({ className: '', innerHTML: '', onclick: null, remove() {}, querySelector: () => ({ onclick: null, addEventListener() {} }) });
  let overlay;
  let clock = 1000;
  let result = 'open';
  const box = {
    esc: (t) => t, tr: (t) => t, typeset: (t) => t, pushLayer() {}, popLayer() {},
    document: { createElement: () => (overlay = node()), body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    Date: { now: () => clock },
  };
  vm.runInNewContext(`${fn}\nthis.ask = styledConfirm;`, box);
  box.ask('Connect?').then((v) => { result = v; });
  overlay.onclick({ target: overlay, detail: 2 });
  clock += 100;
  overlay.onclick({ target: overlay, detail: 1 });
  return Promise.resolve().then(() => {
    assert.equal(result, 'open', 'the confirmation closed on the second click of the double click');
    clock += 1000;
    overlay.onclick({ target: overlay, detail: 1 });
    return Promise.resolve();
  }).then(() => assert.equal(result, false, 'a click on the backdrop later does not cancel any more'));
});

test('CK-548: on a Russian board no setting of the section reads the same as the heading of its group', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
  const core = read('core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const ru = (t) => {
    for (const q of ["'", '"']) {
      const at = dict.indexOf(`${q}${t}${q}: `);
      if (at >= 0) { const v = dict.slice(at + t.length + 4); return v.slice(1, v.indexOf(v[0], 1)); }
    }
    return t;
  };
  const settings = read('settings.js');
  const section = settings.slice(settings.indexOf('async function renderClaudeSection'), settings.indexOf('async function loadClaude'));
  const heads = [...section.matchAll(/class="sk-group-h">\$\{tr\('([^']+)'\)\}/g)].map((m) => ru(m[1]).toLowerCase());
  const labels = [...section.matchAll(/class="set-lab">\$\{tr\('([^']+)'\)\}/g)].map((m) => ru(m[1]).toLowerCase());
  assert.ok(heads.length >= 2 && labels.length >= 4, `the section's headings and settings were not found: ${heads} / ${labels}`);
  assert.deepEqual(labels.filter((l) => heads.includes(l)), [], 'a setting repeats the heading right above it');
});

// node, and node is the responsible process of the tmux under it) and keeps no answer for a program with no bundle.
// The section says so and leads to Full Disk Access, only where the board starts Claude itself — macOS with tmux.
test('CK-591: the macOS access row — Full Disk Access of the board\'s node, read off a file only it opens', async () => {
  claudeFolder();
  const tmux = () => '/opt/homebrew/bin/tmux';
  let d = await setup.claudeSetup({ ...NONE, tmux, fda: () => false, pm2: true });
  assert.deepEqual(d.macos, { node: process.execPath, full_disk: false, pm2: true });
  assert.equal((await setup.claudeSetup({ ...NONE, fda: () => false })).macos, null, 'without tmux the board starts no Claude of its own');
  assert.equal((await setup.claudeSetup({ ...NONE, tmux, platform: 'linux', fda: () => false })).macos, null, 'not macOS');
  // the probe of the file: opened — true; refused — false; not there — null (and nothing is ever written to it)
  const f = join(tmp, 'tcc.db'); writeFileSync(f, 'x');
  if (process.platform === 'darwin') {
    assert.equal(setup.fullDiskAccess(f), true);
    assert.equal(setup.fullDiskAccess(join(tmp, 'no-such.db')), null);
    if (process.getuid?.() !== 0) { chmodSync(f, 0o000); assert.equal(setup.fullDiskAccess(f), false); chmodSync(f, 0o644); }
  } else assert.equal(setup.fullDiskAccess(f), null, 'off macOS there is nothing to ask');
  const r = await import('../public/js/claude-setup-rules.js');
  const no = rows(r.setupView({ ...ALL, macos: { node: '/usr/local/bin/node', full_disk: false, pm2: true } })).macos;
  assert.equal(no.state, 'opt');
  assert.equal(no.value, '/usr/local/bin/node', 'the path to paste is on the row');
  assert.ok(no.say, 'the note hides in a hint');
  assert.equal(no.fix.href, r.PRIVACY_URL);
  assert.match(r.PRIVACY_URL, /^x-apple\.systempreferences:.*Privacy_AllFiles$/);
  assert.match(no.note, /node would like to access data from other apps/);
  assert.equal(rows(r.setupView({ ...ALL, macos: { node: '/n', full_disk: true } })).macos.state, 'ok');
  const term = rows(r.setupView({ ...ALL, macos: { node: '/n', full_disk: false, pm2: false } })).macos;
  assert.equal(term.value, undefined, 'the node path is offered where node is not the one asked about');
  assert.match(term.fix.text, /the app you started the board from/);
  assert.doesNotMatch(term.note, /node would like/);
  assert.equal(rows(r.setupView({ ...ALL, macos: { node: '/n', full_disk: null } })).macos, undefined, 'unknown — no row');
  assert.equal(rows(r.setupView(ALL)).macos, undefined);
  // the link of System Settings opens with no empty tab; a page of the web keeps its new tab
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8');
  const ccLink = new Function('esc', 'tr', `return ${src.match(/const ccLink = (\(f\) => `[^\n]+`);/)[1]}`)((x) => x, (x) => x);
  assert.doesNotMatch(ccLink({ href: r.PRIVACY_URL, label: 'x' }), /target=/);
  assert.match(ccLink({ href: 'https://example.org', label: 'x' }), /target="_blank"/);
});

// the environment (the test always handed it in), the file that tells Full Disk Access is macOS's own database (a typo
// or a readable file there says "has access"), and the words of what to do are drawn before the link.
test('CK-591: pm2 is told by its environment, Full Disk Access by macOS\'s own database, and the steps are on the row', async () => {
  claudeFolder();
  const tmux = () => '/opt/homebrew/bin/tmux';
  const was = process.env.pm_id;
  try {
    delete process.env.pm_id;
    assert.equal((await setup.claudeSetup({ ...NONE, tmux, fda: () => false })).macos.pm2, false, 'a board started from a terminal app is taken for one under pm2');
    process.env.pm_id = '7';
    assert.equal((await setup.claudeSetup({ ...NONE, tmux, fda: () => false })).macos.pm2, true, 'a board under pm2 is not told');
  } finally { if (was === undefined) delete process.env.pm_id; else process.env.pm_id = was; }
  if (process.platform === 'darwin') {
    // the real home: the suite moves HOME into a temporary folder, where neither file is, and any path would agree
    const home = process.env.HOME;
    process.env.HOME = userInfo().homedir;
    try {
      let real;
      try { closeSync(openSync(join(homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'r')); real = true; }
      catch (e) { real = e.code === 'EPERM' || e.code === 'EACCES' ? false : null; }
      assert.notEqual(real, null, 'macOS has no permission database where the test looks for it');
      assert.equal(setup.fullDiskAccess(), real, 'Full Disk Access is read off another file than macOS\'s permission database');
    } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
  }
  const src = readFileSync(fileURLToPath(new URL('../public/js/settings.js', import.meta.url)), 'utf8');
  const at = src.indexOf('function ccFix(');
  const ccLink = `const ccLink = ${src.match(/const ccLink = (\(f\) => `[^\n]+`);/)[1]};`;
  const ccFix = new Function('esc', 'tr', `${ccLink}\n${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nreturn ccFix;`)((x) => x, (x) => x);
  const r = await import('../public/js/claude-setup-rules.js');
  const row = rows(r.setupView({ ...ALL, macos: { node: '/usr/local/bin/node', full_disk: false, pm2: true } })).macos;
  const html = ccFix(row.fix);
  assert.ok(html.includes(row.fix.text) && html.indexOf(row.fix.text) < html.indexOf(r.PRIVACY_URL), 'the steps (+, ⇧⌘G, paste) are not drawn before the link');
});
