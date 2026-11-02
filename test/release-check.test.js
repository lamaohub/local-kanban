// `node scripts/release.js --check` is what CI runs on every push to dev (.github/workflows/release-check.yml):
// the checks of the published snapshot. Run here against a tiny repository that carries a copy of the script, so
// the suite proves the mode itself: it needs no .release-private.json (and uses one that is there), it passes a
// clean snapshot, and it fails on what used to stop a release only on release day.
// The script is a private tool, left out of the published snapshot — there these tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RELEASE = new URL('../scripts/release.js', import.meta.url);
const STRIP = new URL('../scripts/strip-comments.js', import.meta.url);
// a Russian word, built at run time so that this file itself has no Cyrillic in it
const RU = String.fromCodePoint(0x43f, 0x440, 0x43e, 0x432, 0x435, 0x440, 0x43a, 0x430);

function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-release-check-'));
  t.after(() => { for (const d of [dir, `${dir}.tmp`]) rmSync(d, { recursive: true, force: true }); });
  const all = {
    'package.json': '{ "name": "tiny", "version": "1.0.0", "type": "module" }\n',
    'package-lock.json': '{ "name": "tiny", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "tiny", "version": "1.0.0" } } }\n',
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- First.\n',
    '.gitignore': 'node_modules\n',
    'lib.js': 'export const answer = 42; // CK-1: a note about a task, stripped from the snapshot\n',
    'test/lib.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../lib.js';\ntest('the answer', () => { assert.equal(answer, 42); });\n",
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(RELEASE, join(dir, 'scripts', 'release.js'));
  copyFileSync(STRIP, join(dir, 'scripts', 'strip-comments.js'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'feature');
  git('add', '-A');
  git('commit', '-q', '-m', 'tiny');
  return dir;
}
// The check's temporary folder sits next to the repository, not inside it: whatever the tools it runs leave in
// a TMPDIR is not a change the check made to the repository (on CI under Node 24 something was left there, and
// the repository's status showed it as `?? .tmp/`). What the check itself makes there must be gone, though.
function check(dir) {
  const tmp = `${dir}.tmp`;
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'release.js'), '--check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, tmp };
}

test('the check passes a clean snapshot without the private patterns, on any branch, and changes nothing', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  // the CI job that runs the check is private like the script: if the snapshot kept it, a Russian line in it
  // would fail the English check of .github/ — so this one passing means the job is left out
  const dir = repo(t, { '.github/workflows/release-check.yml': `# ${RU}\nname: release check\n` });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const r = check(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tests pass on the snapshot/);
  assert.match(r.out, /release checks pass/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }), head, 'the check committed something');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', 'the check left changes behind');
  assert.deepEqual(readdirSync(r.tmp).filter((n) => n.startsWith('local-kanban-release-')), [], 'the check left its snapshot behind');
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.0.0', 'the check bumped the version');
});

test('the check fails on a file a visitor reads that is not in English', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const r = check(repo(t, { 'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n- ${RU}.\n` }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CHANGELOG\.md: \d+ Cyrillic characters — a visitor reads this file, write it in English/);
});

test('the check fails on a Russian string outside the Russian locale', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const r = check(repo(t, { 'test/words.test.js': `import { test } from 'node:test';\ntest('a word', () => '${RU}');\n` }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test\/words\.test\.js: 8 Cyrillic characters outside the Russian locale/);
});

test('the check catches what looks like a leak without the private patterns (CK-916)', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  // built at run time, or this very file would be the leak
  const ip = ['203', '0', '113', '7'].join('.');
  const home = ['', 'Users', 'someone', 'notes.txt'].join('/');
  const r = check(repo(t, { 'test/ua.test.js': `export const peer = '${ip}';\n`, 'docs/note.md': `Kept in ${home}\n` }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test\/ua\.test\.js:1: IP address/);
  assert.match(r.out, /docs\/note\.md:1: home directory path/);
});

// built at run time, like the others: a key whole would be the leak in this very file
const KEY = ['sk', 'abcdefghij0123456789KLMNOP'].join('-');

test('a finding of a built-in pattern says the line in the repository and what matched', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const ip = ['203', '0', '113', '7'].join('.');
  // the two comments are stripped from the snapshot, where the address stands on line 1: the person opens the source
  const r = check(repo(t, { 'peer.js': `// CK-2: a note\n// CK-3: another\nexport const peer = '${ip}';\n` }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`peer.js:3: IP address — ${ip}`), r.out);
});

test('an API key is found, and the log gets its start, not the key', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const r = check(repo(t, { 'test/key.test.js': `\n\nexport const key = '${KEY}';\n` }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test\/key\.test\.js:3: API key — sk-abcdefghi…/);
  assert.ok(!r.out.includes(KEY), 'the whole key went to the log');
});

test('a private pattern is searched when the file is there, and neither it nor the match reaches the log', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const host = 'tunnel.internal-host.example';
  const dir = repo(t, { 'docs/hosts.md': `# Hosts\n\nThe board sits on ${host}.\n` });
  // after the commit, as in a real checkout: the file is git-ignored there and never in the snapshot
  writeFileSync(join(dir, '.release-private.json'), JSON.stringify({ patterns: ['internal-host\\.example'] }));
  const r = check(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs\/hosts\.md:3: private domain or host$/m);
  assert.ok(!r.out.includes('internal-host'), `a private string went to the log:\n${r.out}`);
});

test('a class name holding "sk-" and addresses of the private ranges are not leaks', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const ips = ['172.16.0.1', '172.20.10.2', '172.31.255.254'];
  const r = check(repo(t, {
    'public/look.css': '.desk-sidebar-with-very-long-class-name { color: red; }\n.my-sk-sidebar-with-very-long-class-name { color: red; }\n',
    'docs/lan.md': `Examples: ${ips.join(', ')}\n`,
  }));
  assert.equal(r.code, 0, r.out);
});

test('an address just outside the private range is still a leak', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  for (const ip of [15, 32].map((n) => ['172', n, '0', '1'].join('.'))) {
    const r = check(repo(t, { 'docs/lan.md': `See ${ip}\n` }));
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`docs/lan.md:1: IP address — ${ip}`), r.out);
  }
});

test('a broken private file is one line naming it, not a stack, and shows nothing of it', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const dir = repo(t, {});
  for (const broken of ['{ "patterns": [ "secret-host.example" ', '{ "patterns": ["(secret-host"] }', '{ "patterns": "secret-host" }']) {
    writeFileSync(join(dir, '.release-private.json'), broken);
    const r = check(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\.release-private\.json cannot be used/);
    assert.ok(!/^\s+at /m.test(r.out), `a stack:\n${r.out}`);
    assert.ok(!r.out.includes('secret-host'), `a private string went to the log:\n${r.out}`);
  }
});

test('a failed check takes its snapshot with it, and the real node_modules stays', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const failing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => { assert.equal(1, 2); });\n";
  // one stop before the link to node_modules is made, one with it in place
  for (const files of [{ 'CHANGELOG.md': `# Changelog\n\n- ${RU}.\n` }, { 'test/red.test.js': failing }]) {
    const dir = repo(t, files);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'keep.txt'), 'real');
    const r = check(dir);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(readdirSync(r.tmp).filter((n) => n.startsWith('local-kanban-release-')), [], 'the failed check left its snapshot behind');
    assert.ok(existsSync(join(dir, 'node_modules', 'keep.txt')), 'the cleanup walked into the real node_modules');
  }
});

test('the check fails on a test that only passes with the comments in place', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const r = check(repo(t, {
    'test/source.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n"
      + "test('the source', () => { assert.match(readFileSync(new URL('../lib.js', import.meta.url), 'utf8'), /answer = 42; \\/\\/ CK-1/); });\n",
  }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the test suite fails ON THE SNAPSHOT/);
});

test('the suite in two steps proves all of it: a red test stops the check on either side', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const red = (name) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${name}', () => { assert.equal(1, 2); });\n`;
  const green = "import { test } from 'node:test';\ntest('fine', () => {});\n";
  const apart = check(repo(t, { 'test/shipped.test.js': red('the file set apart'), 'test/other.test.js': green }));
  assert.equal(apart.code, 1, apart.out);
  assert.match(apart.out, /the file set apart/, 'the file set apart did not run');
  const rest = check(repo(t, { 'test/shipped.test.js': green, 'test/other.test.js': red('a file of the rest') }));
  assert.equal(rest.code, 1, rest.out);
  assert.match(rest.out, /a file of the rest/, 'the rest did not run');
});

test('CI runs the check on every push to dev', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const yml = readFileSync(new URL('../.github/workflows/release-check.yml', import.meta.url), 'utf8');
  assert.match(yml, /^on:\n {2}push:\n {4}branches: \[dev\]$/m, 'the job no longer runs on a push to dev');
  assert.match(yml, /^ {8}run: node scripts\/release\.js --check$/m, 'the job no longer runs the check');
  assert.match(yml, /^ {6}- run: npm ci$/m, 'the snapshot borrows node_modules from the checkout: they have to be installed first');
});
