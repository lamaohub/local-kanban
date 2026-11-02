import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { paceWords } from '../public/js/pace-rules.js';

const here = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');
const PRIVATE = 'scripts/release.js is a private tool and is not part of the published slice';
const noRelease = () => !existsSync(here('scripts/release.js'));

function repo(pkgVersion, extra = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-g-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(here('scripts/release.js'), join(dir, 'scripts/release.js'));
  copyFileSync(here('scripts/strip-comments.js'), join(dir, 'scripts/strip-comments.js'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion, type: 'module' }));
  extra(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'dev'); g('add', '-A');
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x');
  return dir;
}
function release(dir, ...args) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['scripts/release.js', ...args, '--dry-run', '--no-private-patterns'], { cwd: dir, encoding: 'utf8', env });
  return `${r.stdout}\n${r.stderr}`;
}

test('CK-922: patch out of a beta is the release it leads to', (t) => {
  if (noRelease()) return t.skip(PRIVATE);
  const dir = repo('2.0.0-beta.1');
  try { assert.match(release(dir, 'patch'), /release 2\.0\.0-beta\.1 → 2\.0\.0 /); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CK-922: a beta version is taken as asked', (t) => {
  if (noRelease()) return t.skip(PRIVATE);
  const dir = repo('2.0.0-beta.1');
  try { assert.match(release(dir, '2.0.0-beta.2'), /→ 2\.0\.0-beta\.2 /); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CK-922: a release stopped by the tests names the test', (t) => {
  if (noRelease()) return t.skip(PRIVATE);
  const dir = repo('1.0.0', (d) => {
    writeFileSync(join(d, 'CHANGELOG.md'), '## [Unreleased]\n\n- a note\n');
    mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'test/a.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the-failing-one', () => assert.equal(1, 2));\n");
  });
  try {
    const out = release(dir, 'patch');
    assert.match(out, /tests fail/);
    assert.match(out, /the-failing-one/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CK-922: a beta goes out under latest', () => {
  assert.match(read('.github/workflows/publish.yml'), /npm publish[^\n]*--tag latest/);
});

test('CK-903: the release says it is the release when it pushes main', (t) => {
  if (noRelease()) return t.skip(PRIVATE);
  assert.match(read('scripts/release.js'), /\['push', 'origin', 'main'\][^\n]*KB_RELEASE_PUSH: 'main'/);
});

test('CK-896: the skill has Claude read a whole batch first', () => {
  assert.match(read('skills/kanban/SKILL.md'), /Read ALL of them before starting the first/);
});

test('CK-921: the light of a Claude at work is green, of a silent one yellow', () => {
  const css = read('public/style.css');
  assert.match(css, /^\.chat-pulse \{[^}]*background: var\(--ok\)/m);
  assert.match(css, /\.chat-working\.stalled \.chat-pulse[^{]*\{ background: var\(--doing\)/);
});

function page() {
  const src = read('public/js/chat.js').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), paceWords,
    document: { addEventListener: () => {} }, globalThis: { navigator: {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${src}\nthis.workingLine = workingLine;`, box);
  return box;
}

test('CK-921: a step in hand: «working», whatever the counter, and no alarm', () => {
  const AT = '2026-10-30T12:00:00.000Z';
  const html = page().workingLine({ working: true, turns: [{ at: AT, open: true, items: [{ kind: 'tool', tool: 'Bash', text: 'x', at: AT }] }], pace: { tokens: 100 } });
  assert.match(html, /chat-working-t">Claude is working…</);
  assert.match(read('public/js/chat.js'), /stalled\(d\.pace, stepInHand\(d\), c\.paceMark, at\)/);
});
