import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, isNewer, registryCheck, pkg;
const realFetch = globalThis.fetch;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const system = await import('../src/routes/system.js');
  ({ isNewer, registryCheck } = system);
  pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  app = Fastify();
  await app.register(system.default);
  await app.ready();
});

after(async () => { globalThis.fetch = realFetch; await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('the board reports its own version, so an npm install can see which one it runs', async () => {
  const about = (await app.inject({ method: 'GET', url: '/api/about' })).json();
  assert.equal(about.version, pkg.version, 'GET /api/about no longer carries the version');
  assert.equal(typeof about.packaged, 'boolean');
});

test('versions are compared as numbers, not as text', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true, '1.10.0 is newer than 1.9.0 — as text it looks smaller');
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.6.4', '1.6.3'), true);
  assert.equal(isNewer('1.6.3', '1.6.3'), false, 'the same version is not an update');
  assert.equal(isNewer('1.6.2', '1.6.3'), false, 'an older version is never offered');
  assert.equal(isNewer('1.7.0-rc.1', '1.7.0'), false, 'a prerelease of the version you have is not an update');
});

test('the registry answer becomes the same shape the board already renders', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) });
  const r = await registryCheck();
  assert.deepEqual(r, { update_available: true, local: pkg.version, remote: '99.0.0', branch: null, tag: null, dev: null });

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: pkg.version }) });
  assert.equal((await registryCheck()).update_available, false, 'the version you already run is not an update');
});

test('a registry that does not answer says "cannot check" instead of guessing', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await registryCheck(), null, '404 for the package name must not read as "up to date"');

  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await registryCheck(), null, 'a dead network must not read as "up to date"');

  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  assert.equal(await registryCheck(), null, 'an answer without a version is not an answer');
});

test('the git check still comes first, and the registry is only the fallback', async () => {
  const src = readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8');
  assert.match(src, /if \(data\.update_available === null\) data = \(await registryCheck\(\)\) \|\| data;/,
    'the fallback to the registry is gone, or it stopped being a fallback');
});
