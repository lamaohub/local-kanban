import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, isNewer, registryCheck, updatePlan, restartMode, globalPrefixOf, failureReason, pkg;
const realFetch = globalThis.fetch;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const system = await import('../src/routes/system.js');
  ({ isNewer, registryCheck, updatePlan, restartMode, globalPrefixOf, failureReason } = system);
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

test('the registry is asked in a format it actually answers on', async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push({ url: String(url), accept: opts?.headers?.Accept }); return { ok: true, json: async () => ({ version: '99.0.0' }) }; };
  await registryCheck();
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /registry\.npmjs\.org\/local-kanban\/latest$/, 'the registry address changed');
  assert.doesNotMatch(String(seen[0].accept), /install-v1/,
    'the abbreviated media type is back — /latest answers 406 with an empty body for it');
});

test('the git check still comes first, and the registry is only the fallback', async () => {
  const src = readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8');
  assert.match(src, /if \(data\.update_available === null\) data = \(await registryCheck\(\)\) \|\| data;/,
    'the fallback to the registry is gone, or it stopped being a fallback');
});

test('a clone updates itself with git, a package with npm', () => {
  assert.deepEqual(updatePlan({ packaged: false }), { how: 'git', cmd: 'git', args: ['pull', '--ff-only'] });
  const plan = updatePlan({ packaged: true, name: 'local-kanban', root: '/opt/npm/lib/node_modules/local-kanban' });
  assert.equal(plan.how, 'npm');
  assert.deepEqual(plan.args, ['install', '-g', 'local-kanban@latest', '--prefix', '/opt/npm']);
});

test('the update lands where the running copy lives, not in whatever prefix the machine prefers', () => {
  assert.equal(globalPrefixOf('/opt/npm/lib/node_modules/local-kanban', 'local-kanban'), '/opt/npm');
  assert.equal(globalPrefixOf('/opt/npm/lib/node_modules/@acme/board', '@acme/board'), '/opt/npm');
  assert.equal(globalPrefixOf('/tmp/x/node_modules/local-kanban', 'local-kanban'), null);
  assert.equal(globalPrefixOf('', 'local-kanban'), null);
  const plan = updatePlan({ packaged: true, name: 'local-kanban', root: '/tmp/x/node_modules/local-kanban' });
  assert.equal(plan.args.includes('--prefix'), false, 'a made-up prefix is worse than none');
});

test('the board promises a restart only where something can restart it', () => {
  assert.equal(restartMode({ pm_id: '3' }), 'pm2');
  assert.equal(restartMode({}), 'manual', 'started by hand — nobody brings it back');
  assert.equal(restartMode({ pm_id: '' }), 'manual', 'an empty pm_id is not pm2');
});

test('the process exits only in the pm2 case, and only after the answer is sent', () => {
  const src = readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8');
  assert.match(src, /if \(restart === 'pm2'\) setTimeout\(\(\) => process\.exit\(0\), \d+\)/,
    'the board either stopped restarting itself, or started exiting where nothing will bring it back');
  assert.match(src, /if \(updateRunning\) return reply\.code\(409\)/,
    'two updates can run at once again — they race for the same tree');
});

test('a failed update says why, not just that it failed', () => {
  const git = ['Updating a..b', 'From /tmp/origin', '   a..b  dev -> origin/dev',
    'error: Your local changes to the following files would be overwritten by merge:',
    '\tdocs/API.md', 'Please commit your changes or stash them before you merge.', 'Aborting'].join('\n');
  assert.match(failureReason(git), /^error: Your local changes/);

  const npm = ['npm error code EACCES', 'npm error syscall mkdir', 'npm error errno -13',
    "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/local-kanban'",
    'npm error A complete log of this run can be found in: /home/user/.npm/_logs/x.log'].join('\n');
  assert.match(failureReason(npm), /EACCES: permission denied/);

  assert.equal(failureReason('first\nsecond'), 'second', 'with nothing marked as an error, the last line is the best guess');
  assert.equal(failureReason('', 'the command failed'), 'the command failed', 'empty output still owes the caller a reason');
});

test('a real npm permission failure names the cause, not the debug log', () => {
  const npm = [
    'npm error     at async [reifyPackages] (/opt/node/lib/node_modules/npm/node_modules/@npmcli/arborist/lib/arborist/reify.js:325:11)',
    'npm error     at async Arborist.reify (/opt/node/lib/node_modules/npm/node_modules/@npmcli/arborist/lib/arborist/reify.js:142:5)',
    'npm error   errno: -13,',
    "npm error   code: 'EACCES',",
    "npm error   syscall: 'rename',",
    "npm error   path: '/usr/local/lib/node_modules/local-kanban',",
    "npm error   dest: '/usr/local/lib/node_modules/.local-kanban-09BIK8wD'",
    'npm error }',
    'npm error',
    'npm error The operation was rejected by your operating system.',
    'npm error It is likely you do not have the permissions to access this file as the current user',
    'npm notice New major version of npm available! 10.9.0 -> 12.0.2',
    'npm error A complete log of this run can be found in: /opt/npm-cache/_logs/2026-08-21T16_41_53_985Z-debug-0.log',
  ].join('\n');
  const said = failureReason(npm);
  assert.doesNotMatch(said, /A complete log of this run/, 'the path to a debug log is not a reason');
  assert.doesNotMatch(said, /arborist/, 'a stack frame of npm itself is not a reason either');
  assert.match(said, /permissions/, 'the one thing the person has to know is that it is about permissions');
});

test('a failed update hands back the command to run by hand', () => {
  const src = readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8');
  assert.match(src, /cmd: \[plan\.cmd, \.\.\.plan\.args\]\.join\(' '\)/,
    'the failure answer stopped carrying the command, so the person has nothing to run');
  const front = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(front, /showFailCmd\(err\.body\?\.cmd\)/, 'the tab stopped showing that command');
  assert.match(front, /about-upd-cmd/, 'there is nowhere to show it anymore');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  assert.match(core, /apiError\(data\.error \|\| res\.status, \{ status: res\.status, body: data \}\)/,
    'the body of a refusal no longer reaches the caller, so `cmd` cannot get through');
});

test('the update dialog says what happens to tasks and to the skills', () => {
  const front = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(front, /Your tasks are not touched/, 'the dialog stopped promising that tasks survive');
  assert.match(front, /Afterwards refresh the skills Claude reads:[\s\S]{0,80}local-kanban skills/,
    'the packaged install is no longer told to refresh its copied skills');
  assert.match(front, /and refresh the skills:[\s\S]{0,80}local-kanban skills/,
    'the same reminder is gone from the line shown after a manual-restart update');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const key of ['Your tasks are not touched', 'Afterwards refresh the skills Claude reads:', 'Run it yourself']) {
    assert.ok(core.includes(key), `no Russian translation for: ${key}`);
  }
});

test('the update endpoints are documented where integrators look', () => {
  const api = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');
  assert.match(api, /`POST \/api\/update`/, 'the endpoint that updates the board is undocumented');
  assert.match(api, /restart: "pm2"/, 'the doc no longer explains what the caller must do after an update');
  assert.match(api, /update_available: null/, 'the doc stopped warning that "cannot check" is not "up to date"');
});
