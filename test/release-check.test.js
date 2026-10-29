// `node scripts/release.js --check` is what CI runs on every push to dev (.github/workflows/release-check.yml):
// the checks of the published snapshot that need nothing private. Run here against a tiny repository that
// carries a copy of the script, so the suite proves the mode itself: it needs no .release-private.json, it
// passes a clean snapshot, and it fails on the three things that used to stop a release only on release day.
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

test('the check fails on a test that only passes with the comments in place', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const r = check(repo(t, {
    'test/source.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n"
      + "test('the source', () => { assert.match(readFileSync(new URL('../lib.js', import.meta.url), 'utf8'), /answer = 42; \\/\\/ CK-1/); });\n",
  }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the test suite fails ON THE SNAPSHOT/);
});

test('CI runs the check on every push to dev', (t) => {
  if (!existsSync(RELEASE)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const yml = readFileSync(new URL('../.github/workflows/release-check.yml', import.meta.url), 'utf8');
  assert.match(yml, /^on:\n {2}push:\n {4}branches: \[dev\]$/m, 'the job no longer runs on a push to dev');
  assert.match(yml, /^ {8}run: node scripts\/release\.js --check$/m, 'the job no longer runs the check');
  assert.match(yml, /^ {6}- run: npm ci$/m, 'the snapshot borrows node_modules from the checkout: they have to be installed first');
});
