import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAYCAST = join(ROOT, 'scripts', 'raycast', 'open-kanban.sh');

test('the Raycast command keeps the directives Raycast needs to register it', () => {
  assert.ok(existsSync(RAYCAST), 'scripts/raycast/open-kanban.sh is part of the package');
  const text = readFileSync(RAYCAST, 'utf8');
  // schemaVersion and title are mandatory; without title the command does not appear at all
  for (const directive of ['@raycast.schemaVersion', '@raycast.title', '@raycast.mode']) {
    const line = text.split('\n').find((l) => l.trim().startsWith(`# ${directive}`));
    assert.ok(line, `${directive} is missing — Raycast would not register the command`);
    assert.ok(line.trim().length > `# ${directive}`.length + 1, `${directive} has no value`);
  }
  assert.match(text, /^#!/, 'the shebang survives');
  assert.doesNotMatch(text, /[\u0430-\u044f\u0451\u0410-\u042f\u0401]/,
    'a shipped shell script is English, so nothing gets stripped out of it');
});

test('every package.json script points at a path the package actually ships', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ships = (path) => pkg.files.some((f) => (f.endsWith('/') ? path.startsWith(f) : path === f));

  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const token of cmd.split(/\s+/)) {
      if (!/^[\w./-]+\.(js|cjs|mjs|sh)$/.test(token)) continue;
      assert.ok(existsSync(join(ROOT, token)), `${name}: ${token} does not exist`);
      assert.ok(ships(token), `${name}: ${token} is not in "files", so the script cannot run in the package`);
    }
  }
  assert.equal(pkg.scripts?.test, undefined,
    'there is no test script: test/ is not published, so it would pass without running anything');
});

test('the package can refresh the skills it copied', () => {
  const cli = readFileSync(new URL('../bin/local-kanban', import.meta.url), 'utf8');
  assert.match(cli, /local-kanban skills/, 'the skills subcommand disappeared from the help');
  assert.match(cli, /if \(cmd === 'skills'\)/, 'there is no way to refresh the skills after an update again');
  assert.match(cli, /function installSkills\(/, 'the wizard and the refresh no longer share one implementation');
});

test('the update hint matches how the board was installed', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /const updateHint = \(\) => \(about\?\.packaged/,
    'the About section tells an npm install to run npm run update, which it does not have');
  for (const name of ['README.md', 'README.ru.md']) {
    const readme = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(readme, /npm install -g local-kanban@latest/, `${name} only explains how to update a clone`);
  }
});

test('the contrib bootstrap points at an example that exists and matches what it reads', () => {
  const script = readFileSync(join(ROOT, 'contrib', 'bootstrap.js'), 'utf8');
  assert.match(script, /seed-projects\.example\.json/,
    'the missing-seed message stopped naming the example to copy');
  assert.doesNotMatch(script, /seed-from-panel/,
    'the message sends the reader to a file that is not in git again');

  const example = join(ROOT, 'contrib', 'seed-projects.example.json');
  assert.ok(existsSync(example), 'the example the message tells you to copy is missing');
  const seed = JSON.parse(readFileSync(example, 'utf8'));
  assert.ok(Array.isArray(seed) && seed.length, 'the example is a JSON array of projects');
  for (const p of seed) assert.ok(p.slug && p.name, 'every example project carries the required slug and name');

  const read = [...script.matchAll(/\w+: p\.(\w+)/g)].map((m) => m[1]);
  for (const key of Object.keys(seed[0])) {
    assert.ok(read.includes(key), `${key} is in the example but bootstrap.js never reads it`);
  }
});

test('the request to support the project points at a page that exists', () => {
  assert.ok(existsSync(join(ROOT, 'docs', 'COMMERCIAL.md')), 'docs/COMMERCIAL.md is missing');
  for (const name of ['README.md', 'README.ru.md']) {
    assert.match(readFileSync(join(ROOT, name), 'utf8'), /\(docs\/COMMERCIAL\.md\)/,
      `${name} no longer links to the page that explains it`);
  }
  const settings = readFileSync(join(ROOT, 'public', 'js', 'settings.js'), 'utf8');
  assert.match(settings, /github\.com\/[\w.-]+\/[\w.-]+\/blob\/main\/docs\/COMMERCIAL\.md/,
    'the About section stopped linking to the page');
});

test('the install check asks for the page, not only for the API', () => {
  for (const wf of ['test.yml', 'publish.yml']) {
    const yml = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.match(yml, /<div id="board"/, `${wf} would stay green on a package built without public/`);
  }
});
