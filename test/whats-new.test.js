import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, changelogSection, repoSlug, pkg, system;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const realGhBin = process.env.KB_GH_BIN;
const get = async (url, on = app) => (await on.inject({ method: 'GET', url })).json();
const fresh = async () => { const a = Fastify(); await a.register(system.default); await a.ready(); return a; };
const noGh = () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  process.env.PATH = '/nonexistent';
  process.env.KB_GH_BIN = '/nonexistent/gh';
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  system = await import('../src/routes/system.js');
  ({ changelogSection, repoSlug } = system);
  pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  app = Fastify();
  await app.register(system.default);
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch; process.env.PATH = realPath;
  if (realGhBin === undefined) delete process.env.KB_GH_BIN; else process.env.KB_GH_BIN = realGhBin;
  await app?.close(); rmSync(tmp, { recursive: true, force: true });
});

const LOG = `# Changelog

## [Unreleased]

## [2.0.0]

### Added

- **A thing.** It does something.

## [1.9.0]

### Fixed

- An older note nobody asked for.
`;

test('a version section stops where the next one begins', () => {
  const s = changelogSection(LOG, '2.0.0');
  assert.match(s, /A thing/);
  assert.doesNotMatch(s, /older note/, 'the section swallowed the version below it');
  assert.doesNotMatch(s, /^## /m, 'the heading of the next section leaked into the notes');
});

test('a version with no section, and an empty section, both read as "no notes"', () => {
  assert.equal(changelogSection(LOG, '3.1.4'), null, 'a version that was never released has no notes');
  assert.equal(changelogSection(LOG, 'Unreleased'), null, 'an empty section is not notes — it would render as a blank block');
  assert.equal(changelogSection('', '1.0.0'), null);
});

test('the repository is read from package.json, so a fork needs no code change', () => {
  assert.equal(repoSlug('git+https://github.com/octocat/hello-world.git'), 'octocat/hello-world');
  assert.equal(repoSlug('https://github.com/octocat/hello-world'), 'octocat/hello-world');
  assert.equal(repoSlug('git@github.com:octocat/hello-world.git'), 'octocat/hello-world');
  assert.equal(repoSlug('https://example.com/octocat/hello-world'), null, 'not GitHub — there is no release page to read');
  assert.equal(repoSlug(null), null);
  assert.equal(repoSlug(undefined), null);
});

test('own notes come off the disk and ask the network for nothing', async () => {
  let asked = 0;
  globalThis.fetch = async () => { asked += 1; throw new Error('the local answer must not go to the network'); };
  const n = await get('/api/whats-new');
  assert.equal(asked, 0, 'reading the changelog next to the code went to the network');
  assert.equal(n.version, pkg.version, 'the notes must be labelled with the version they belong to');
  assert.equal(n.source, 'changelog');
  assert.ok(n.notes && n.notes.length > 10, 'the section for the installed version came back empty');
  assert.doesNotMatch(n.notes, /^## /m, 'the answer carries more than one version section');
});

test('the release page answers for the version that is not installed yet', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /repos\/[\w.-]+\/[\w.-]+\/releases\/latest$/, 'the release address changed');
    return { ok: true, json: async () => ({ tag_name: 'v99.0.0', body: '### Added\n\n- Something new.', html_url: 'https://github.com/octocat/hello-world/releases/tag/v99.0.0' }) };
  };
  const n = await get('/api/whats-new?remote=1&refresh=1');
  assert.equal(n.version, '99.0.0', 'the v prefix of the tag is not a version number');
  assert.equal(n.source, 'github');
  assert.match(n.notes, /Something new/);
  assert.match(n.url, /^https:\/\/github\.com\//, 'the link to the release page is what makes the block checkable');
});

test('no release page, no network, no body — the block still says something true', async () => {
  noGh();
  const offline = await get('/api/whats-new?remote=1&refresh=1', await fresh());
  assert.equal(offline.source, 'changelog', 'a dead network must not leave the block empty');
  assert.equal(offline.version, pkg.version);
  // the label alone proves nothing: an answer that says "changelog" and carries no notes renders
  // exactly the blank block this fallback exists to prevent
  assert.ok(offline.notes && offline.notes.length > 10, 'the fallback is labelled right but came back empty');

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', body: '   ' }) });
  const blank = await get('/api/whats-new?remote=1&refresh=1', await fresh());
  assert.equal(blank.source, 'changelog', 'a release created without notes is not notes');
  assert.ok(blank.notes && blank.notes.length > 10, 'a release without notes fell back to an empty block');
});

test('the notes are escaped before they are formatted, not after', () => {
  const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function mdInline'), src.indexOf('export function mdLite'));
  assert.ok(fn.includes('esc(text)'), 'mdInline no longer escapes the text it was given');
  assert.ok(fn.indexOf('esc(text)') < fn.indexOf('.replace('), 'formatting happens before escaping — a tag in the release body would reach the page');
});

test('the release page is filled from the same section the release script demanded', (t) => {
  const path = new URL('../scripts/release.js', import.meta.url);
  if (!existsSync(path)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const src = readFileSync(path, 'utf8');
  assert.match(src, /const releaseNotes = notesOf\(changelogText\)/, 'the notes are no longer taken from Unreleased');
  assert.match(src, /writeFileSync\(notesFile, `\$\{releaseNotes\}/, 'the release page is filled from something else than those notes');
  assert.match(src, /'release', verb, `v\$\{version\}`/, 'the release page is not created at all');
});

test('refresh=1 goes to GitHub at most once in 15 seconds', async () => {
  let asked = 0;
  globalThis.fetch = async () => {
    asked += 1;
    return { ok: true, json: async () => ({ tag_name: 'v99.0.0', body: `- release ${asked}`, html_url: 'https://github.com/octocat/hello-world/releases/tag/v99.0.0' }) };
  };
  const board = await fresh();
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push(await get('/api/whats-new?remote=1&refresh=1', board));
  assert.equal(asked, 1, `five presses of "Check" made ${asked} trips to GitHub`);
  assert.ok(answers.every((a) => a.source === 'github' && a.notes === '- release 1'), 'a throttled press must still answer — from the cache');
  await board.close();
});

const slow = (answer) => async () => { await new Promise((r) => setTimeout(r, 30)); return answer(); };
function countingGh(name) {
  const runs = join(tmp, `${name}.runs`);
  const bin = join(tmp, `${name}.sh`);
  writeFileSync(bin, `#!/bin/sh\necho run >> "${runs}"\nsleep 0.1\nexit 1\n`);
  chmodSync(bin, 0o755);
  return { bin, count: () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').length : 0) };
}

test('twenty requests at once on a cold cache make one trip to the release page', async () => {
  let asked = 0;
  globalThis.fetch = slow(() => {
    asked += 1;
    return { ok: true, json: async () => ({ tag_name: 'v99.0.0', body: '- one trip', html_url: 'https://github.com/octocat/hello-world/releases/tag/v99.0.0' }) };
  });
  const board = await fresh();
  const answers = await Promise.all(Array.from({ length: 20 }, () => get('/api/whats-new?remote=1', board)));
  assert.equal(asked, 1, `20 requests at once made ${asked} trips to GitHub`);
  assert.ok(answers.every((a) => a.source === 'github' && a.notes === '- one trip'), 'a request that waited for the trip got another answer');
  await get('/api/whats-new?remote=1', board);
  assert.equal(asked, 1, 'once the trip is back, the next request does not come from the cache');
  // and the trip does end: two hours later the cache is stale, and the next request goes out again
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3_600_000;
  try { await get('/api/whats-new?remote=1', board); } finally { Date.now = realNow; }
  assert.equal(asked, 2, 'the first trip is handed out forever: the board never asks GitHub again');
  await board.close();
});

test('twenty requests at once with the anonymous request refused run gh once', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const gh = countingGh('gh-news');
  process.env.KB_GH_BIN = gh.bin;
  const board = await fresh();
  const answers = await Promise.all(Array.from({ length: 20 }, () => get('/api/whats-new?remote=1&refresh=1', board)));
  assert.equal(gh.count(), 1, `20 requests at once ran gh under the owner's token ${gh.count()} times`);
  assert.ok(answers.every((a) => a.source === 'changelog' && a.notes && a.notes.length > 10), 'the requests that waited did not get the own notes');
  await board.close();
});
