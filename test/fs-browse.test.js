import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, work;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = join(tmp, 'projects');
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  work = mkdtempSync(join(tmpdir(), 'kb-fs-'));
  mkdirSync(join(work, 'alpha'));
  mkdirSync(join(work, 'beta'));
  mkdirSync(join(work, '.hidden'));
  writeFileSync(join(work, 'notes.txt'), 'secret');

  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});

after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

test('browsing a folder returns its subfolders and nothing else', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/fs?path=${encodeURIComponent(work)}` });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.deepEqual(d.dirs, ['alpha', 'beta'], 'only real subfolders, sorted');
  assert.ok(!d.dirs.includes('.hidden'), 'dotfolders are noise in a home directory, not choices');
  assert.ok(!d.dirs.includes('notes.txt'), 'files must never be listed — the board browses folders, not contents');
  assert.equal(typeof d.parent, 'string', 'there is a way up');
  assert.equal(d.home, homedir());
});

test('a tilde means home, the way a person writes it', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/fs?path=~' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().path, homedir());
});

test('the filesystem root has no way up', async () => {
  const d = (await app.inject({ method: 'GET', url: '/api/fs?path=/' })).json();
  assert.equal(d.parent, null, 'above / there is nothing, and ".." must not appear');
});

test('the three ways to ask for the wrong thing are told apart', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/fs?path=/no/such/place/here' })).statusCode, 404);
  const file = (await app.inject({ method: 'GET', url: `/api/fs?path=${encodeURIComponent(join(work, 'notes.txt'))}` }));
  assert.equal(file.statusCode, 400, 'a file is not a folder, and saying so beats an empty list');
  assert.equal((await app.inject({ method: 'GET', url: '/api/fs?path=a&path=b' })).statusCode, 400, 'a repeated parameter arrives as an array');
});

test('closing the system dialog is not a failure', () => {
  const src = readFileSync(new URL('../src/routes/projects.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!res\.out\) return \{ path: null, cancelled: true \};/,
    'a cancelled folder dialog is being reported as an error again');
  assert.match(src, /return reply\.code\(501\)\.send\(\{ error: `no folder dialog on \$\{process\.platform\}` \}\)/,
    'a platform without a folder dialog must say so, so the interface can fall back to its own browser');
});
