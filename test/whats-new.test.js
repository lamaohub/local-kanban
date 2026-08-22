import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, changelogSection, repoSlug, pkg;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
const get = async (url) => (await app.inject({ method: 'GET', url })).json();
const noGh = () => { globalThis.fetch = async () => { throw new Error('offline'); }; process.env.PATH = '/nonexistent'; };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const system = await import('../src/routes/system.js');
  ({ changelogSection, repoSlug } = system);
  pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  app = Fastify();
  await app.register(system.default);
  await app.ready();
});

after(async () => { globalThis.fetch = realFetch; process.env.PATH = realPath; await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

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
  const offline = await get('/api/whats-new?remote=1&refresh=1');
  assert.equal(offline.source, 'changelog', 'a dead network must not leave the block empty');
  assert.equal(offline.version, pkg.version);

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', body: '   ' }) });
  const blank = await get('/api/whats-new?remote=1&refresh=1');
  assert.equal(blank.source, 'changelog', 'a release created without notes is not notes');
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
