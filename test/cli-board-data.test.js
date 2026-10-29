// settings.json or skill file they replaced in the data folder of their OWN process (KB_DATA_DIR, or the default) —
// not among the backups of the board they connect, where its Backups section looks. Now they ask the running board
// where its data folder is (GET /api/about, at KB_URL / --port / 3100, as kb does); a board that does not answer needs
// the folder named with --data, and without it nothing is written.
// The real binary against a real board (the system routes on a socket of their own, with a data folder of their own)
// and against a board that is not there. Every address is a socket of the test's own: nothing reaches a real board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const LK = fileURLToPath(new URL('../bin/local-kanban', import.meta.url));
const OWNER = { model: 'opus', statusLine: { type: 'command', command: 'node /home/user/.claude/my-statusline.js' } };
let tmp, app, board, boardData, dead;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-test-')));
  boardData = join(tmp, 'board-data'); // the board's data folder: not the default, not the command's own
  process.env.KB_DATA_DIR = boardData;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  board = `http://127.0.0.1:${app.server.address().port}`;
  // an address where nothing listens: a port taken and given back
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  dead = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
/** A Claude folder with a settings.json of the person's own, and the folder this process would keep copies in. */
function setup() {
  const dir = join(tmp, `case-${++n}`);
  const claude = join(dir, 'claude');
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(OWNER, null, 2));
  return { claude, own: join(dir, 'own-data') };
}
const run = (args, { claude, own }, url) => new Promise((resolve) => {
  execFile(process.execPath, [LK, ...args], {
    env: { PATH: process.env.PATH, HOME: join(tmp, 'home'), TMPDIR: tmp, KB_CLAUDE_DIR: claude, KB_DATA_DIR: own, KB_URL: url },
  }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const copies = (data, kind) => (existsSync(join(data, 'backups', kind)) ? readdirSync(join(data, 'backups', kind)) : []);

test('GET /api/about names the board\'s data folder', async () => {
  const about = await (await fetch(`${board}/api/about`)).json();
  assert.equal(about.data_dir, boardData);
});

test('hooks: the copy of settings.json goes among the backups of the board the command asked', async () => {
  const c = setup();
  const was = copies(boardData, 'claude-settings').length;
  const r = await run(['hooks', 'install', '--yes'], c, board);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const kept = copies(boardData, 'claude-settings');
  assert.equal(kept.length, was + 1, `no copy among the board's backups:\n${r.stdout}`);
  assert.deepEqual(copies(c.own, 'claude-settings'), [], 'the copy went to the data folder of the command\'s own process');
  assert.match(r.stdout, new RegExp(`kept as ${join(boardData, 'backups', 'claude-settings').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('hooks: a board that does not answer and no --data — a refusal, and nothing is written anywhere', async () => {
  const c = setup();
  const before = readFileSync(join(c.claude, 'settings.json'), 'utf8');
  const r = await run(['hooks', 'install', '--yes'], c, dead);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /does not answer.*--data <dir>.*Nothing was written/s);
  assert.equal(readFileSync(join(c.claude, 'settings.json'), 'utf8'), before, 'settings.json was written all the same');
  assert.deepEqual(copies(c.own, 'claude-settings'), [], 'a copy was kept in a folder nobody looks in');
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'a raw stack instead of a message');
});

test('hooks: --data names the folder, and the board is not needed', async () => {
  const c = setup();
  const named = join(tmp, 'named-data');
  const r = await run(['hooks', 'install', '--yes', '--data', named], c, dead);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(copies(named, 'claude-settings').length, 1);
  assert.deepEqual(copies(c.own, 'claude-settings'), []);
});

test('hooks: a board from before CK-536 tells only where its database is — the copy goes next to it', async () => {
  const c = setup();
  const old = join(tmp, 'old-board-data');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/about' ? { db_path: join(old, 'kanban.db'), version: '1.15.0' } : {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await run(['hooks', 'install', '--yes'], c, `http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(copies(old, 'claude-settings').length, 1);
});

test('hooks: a new settings.json keeps no copy, so no board is asked', async () => {
  const c = setup();
  rmSync(join(c.claude, 'settings.json'));
  const r = await run(['hooks', 'install', '--yes'], c, dead);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(c.claude, 'settings.json')));
});

test('skills: a replaced skill file goes among the board\'s backups; without the board — --data or a refusal', async () => {
  const c = setup();
  const skill = join(c.claude, 'skills', 'kanban', 'SKILL.md');
  mkdirSync(join(skill, '..'), { recursive: true });
  writeFileSync(skill, '# kanban, edited by hand\n');
  // the board down, nothing named: refused, the edited file stays
  let r = await run(['skills'], c, dead);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /does not answer.*--data <dir>/s);
  assert.equal(readFileSync(skill, 'utf8'), '# kanban, edited by hand\n', 'the skill was replaced although its copy had nowhere to go');
  assert.deepEqual(copies(c.own, 'skills'), []);
  // the board up: the copy goes among its backups
  const was = copies(boardData, 'skills').length;
  r = await run(['skills'], c, board);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(copies(boardData, 'skills').length, was + 1, `no copy among the board's backups:\n${r.stdout}`);
  assert.deepEqual(copies(c.own, 'skills'), []);
  // --data with the board down
  writeFileSync(skill, '# edited again\n');
  const named = join(tmp, 'named-skills-data');
  r = await run(['skills', '--data', named], c, dead);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(copies(named, 'skills').length, 1);
});
