import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LK = fileURLToPath(new URL('../bin/local-kanban', import.meta.url));
const PKG = (name) => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
let tmp;

before(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-test-'))); mkdirSync(join(tmp, 'tmp')); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// only what the run needs: nothing of the outer environment (a real KB_DATA_DIR, CLAUDE_CONFIG_DIR…) leaks in.
// (--data), and no board is asked: the default address is a real board on the machine that runs the tests
const runLK = (args, env, cwd = tmp) => new Promise((resolve) => {
  const named = args[0] === 'skills' && env.KB_DATA_DIR ? ['--data', env.KB_DATA_DIR] : [];
  execFile(process.execPath, [LK, ...args, ...named], { cwd, env: { PATH: process.env.PATH, TMPDIR: join(tmp, 'tmp'), ...env } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const snapshots = (data) => (existsSync(join(data, 'backups', 'skills')) ? readdirSync(join(data, 'backups', 'skills')).sort() : []);

test('local-kanban skills refreshes in place: the person\'s own files stay, a replaced SKILL.md is snapshotted first', async () => {
  const home = join(tmp, 'h1');
  const data = join(tmp, 'd1');
  const skills = join(home, '.claude', 'skills');
  write(join(skills, 'deploy', 'SKILL.md'), '# my OWN deploy skill\n');
  write(join(skills, 'deploy', 'references', 'runbook.md'), 'server list, runbook\n');
  write(join(skills, 'deploy', 'scripts', 'go.sh'), 'echo deploy\n');
  write(join(skills, 'kanban', 'SKILL.md'), '# kanban, locally edited\n');
  write(join(skills, 'kanban', 'references', 'my-notes.md'), 'my notes\n');

  const r = await runLK(['skills'], { HOME: home, KB_DATA_DIR: data });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(skills, 'deploy', 'SKILL.md'), 'utf8'), PKG('deploy'));
  assert.equal(readFileSync(join(skills, 'kanban', 'SKILL.md'), 'utf8'), PKG('kanban'));
  assert.equal(readFileSync(join(skills, 'deploy', 'references', 'runbook.md'), 'utf8'), 'server list, runbook\n', 'references/ of the person\'s own skill was wiped');
  assert.equal(readFileSync(join(skills, 'deploy', 'scripts', 'go.sh'), 'utf8'), 'echo deploy\n', 'scripts/ was wiped');
  assert.equal(readFileSync(join(skills, 'kanban', 'references', 'my-notes.md'), 'utf8'), 'my notes\n');

  const kept = snapshots(data);
  const deploy = kept.find((f) => f.startsWith('deploy-'));
  const kanban = kept.find((f) => f.startsWith('kanban-'));
  assert.ok(deploy && kanban, `no snapshot of the replaced SKILL.md files: ${kept}`);
  assert.equal(readFileSync(join(data, 'backups', 'skills', deploy), 'utf8'), '# my OWN deploy skill\n');
  assert.equal(readFileSync(join(data, 'backups', 'skills', kanban), 'utf8'), '# kanban, locally edited\n');
  assert.match(r.stdout, /the previous one is kept as .*deploy-/, 'the output does not say where the old SKILL.md went');

  const again = await runLK(['skills'], { HOME: home, KB_DATA_DIR: data });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(snapshots(data), kept, 'a refresh that changes nothing still took snapshots');
  assert.equal(again.stdout.match(/already matches the package/g)?.length, 2, again.stdout);
});

test('local-kanban skills says so when a skill could not be refreshed, and leaves that skill as it was', async () => {
  // The data folder is a regular file: the snapshot of the replaced SKILL.md cannot be made (for anyone,
  // root included), so the skill must stay as it is — and the summary used to say all the same that the
  // skills "now match this version of the package", with code 0.
  const home = join(tmp, 'h5');
  const data = join(tmp, 'd5-is-a-file');
  writeFileSync(data, '');
  const skills = join(home, '.claude', 'skills');
  write(join(skills, 'deploy', 'SKILL.md'), '# my OWN deploy skill\n');
  const r = await runLK(['skills'], { HOME: home, KB_DATA_DIR: data });
  assert.equal(readFileSync(join(skills, 'deploy', 'SKILL.md'), 'utf8'), '# my OWN deploy skill\n', 'the skill was overwritten without a snapshot');
  assert.equal(readFileSync(join(skills, 'kanban', 'SKILL.md'), 'utf8'), PKG('kanban'), 'a skill with nothing to keep was not installed');
  assert.notEqual(r.code, 0, `a refresh that failed exited 0:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /now match this version/, 'the summary says the skills match the package although one was not refreshed');
  assert.match(r.stdout, /deploy.*could not be refreshed/s);
});

// destination, and `local-kanban skills` wrote the package's text into the person's own file
test('a SKILL.md that links to a file of the person\'s own is not written through', async () => {
  const home = join(tmp, 'h6');
  const own = join(tmp, 'own-skill-file.md');
  writeFileSync(own, '# my own kanban, linked into the folder\n');
  mkdirSync(join(home, '.claude', 'skills', 'kanban'), { recursive: true });
  symlinkSync(own, join(home, '.claude', 'skills', 'kanban', 'SKILL.md'));
  const r = await runLK(['skills'], { HOME: home, KB_DATA_DIR: join(tmp, 'd6') });
  assert.equal(readFileSync(own, 'utf8'), '# my own kanban, linked into the folder\n', 'the file behind the link was written');
  assert.notEqual(r.code, 0, `a skill that was not refreshed exited 0:\n${r.stdout}`);
  assert.match(r.stdout, /kanban.*goes through a link/s);
  assert.equal(readFileSync(join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), 'utf8'), PKG('deploy'), 'the other skill was not installed');
});

test('a skill that is a symlink is not touched', async () => {
  const home = join(tmp, 'h2');
  const personal = join(tmp, 'personal-kanban');
  write(join(personal, 'SKILL.md'), '# the owner\'s own file in another repository\n');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(personal, join(home, '.claude', 'skills', 'kanban'));
  const r = await runLK(['skills'], { HOME: home, KB_DATA_DIR: join(tmp, 'd2') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /kanban is a symlink — nothing to refresh/);
  assert.equal(readFileSync(join(personal, 'SKILL.md'), 'utf8'), '# the owner\'s own file in another repository\n');
});

test('with CLAUDE_CONFIG_DIR the skills go where Claude Code reads them', async () => {
  const home = join(tmp, 'h3');
  const cfg = join(tmp, 'claude-config');
  mkdirSync(home, { recursive: true });
  const r = await runLK(['skills'], { HOME: home, KB_DATA_DIR: join(tmp, 'd3'), CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(cfg, 'skills', 'kanban', 'SKILL.md'), 'utf8'), PKG('kanban'));
  assert.equal(readFileSync(join(cfg, 'skills', 'deploy', 'SKILL.md'), 'utf8'), PKG('deploy'));
  assert.equal(existsSync(join(home, '.claude')), false, 'the skills went to ~/.claude, which this Claude Code does not read');
  assert.match(r.stdout, new RegExp(`The skills in ${join(cfg, 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} now match`));
});

test('start --data=~/x opens the data folder in HOME, not a folder named "~" in the current one', async () => {
  const home = join(tmp, 'h4');
  const cwd = join(tmp, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const busy = createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  try {
    const r = await runLK(['start', '--port', String(busy.address().port), '--data=~/x'],
      { HOME: home, KB_CLAUDE_DIR: join(tmp, 'claude4'), KB_TMUX_SOCKET: `kb-test-lk-${process.pid}`, KB_GH_BIN: join(tmp, 'no-gh') }, cwd);
    assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /already taken/, 'the board did not get as far as the port');
    assert.equal(existsSync(join(cwd, '~')), false, 'a real folder named "~" appeared in the current folder');
    assert.equal(existsSync(join(home, 'x', 'kanban.db')), true, 'the database is not in ~/x');
  } finally { busy.close(); }
});

// step, the same installSkills) made it, and `local-kanban hooks install` then passed its own check
test('local-kanban skills makes no Claude folder KB_CLAUDE_DIR names that is not there', async () => {
  const typo = join(tmp, 'no-such-claude');
  const data = join(tmp, 'd-typo');
  const r = await runLK(['skills'], { HOME: join(tmp, 'h-typo'), KB_DATA_DIR: data, KB_CLAUDE_DIR: typo, KB_URL: 'http://127.0.0.1:9' });
  assert.notEqual(r.code, 0, r.stdout);
  assert.match(r.stdout, /does not exist — check KB_CLAUDE_DIR/);
  assert.ok(!existsSync(typo), 'local-kanban skills made the folder KB_CLAUDE_DIR names');
});
