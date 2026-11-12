// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { notOnMain, shipAsker, showsShip, SHIP_WORDS } from '../public/js/shipped-rules.js';
import { bin } from '../src/bin-path.js';
// start of tmux in the tests beside this file for 10 s and more
const GIT = bin('git');

let app, tmp, repo, db, forgetShipped, pid, n = 0;
const git = (...a) => execFileSync(GIT, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...a], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (message, file = `f${(n += 1)}`) => { writeFileSync(join(repo, file), String(n)); git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
const task = (no, status = 'review', extra = {}) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels, gh_issue_number) VALUES (?, ?, ?, ?, ?, ?)')
  .run(pid, no, 'T', status, extra.labels || '[]', extra.issue ?? null).lastInsertRowid;
const look = async (q = '?project=demo') => { forgetShipped(); return (await app.inject({ method: 'GET', url: `/api/shipped${q}` })).json().tasks; };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  repo = mkdtempSync(join(tmpdir(), 'kb-ship-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ forgetShipped } = await import('../src/shipped.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  git('init', '-q', '-b', 'main');
  commit('first');
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('gh.owner', 'lamaohub'), ('gh.repo', 'lamaohub/server-comp')").run();
  pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('demo','DM','demo',100,?)").run(repo).lastInsertRowid;
  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); for (const d of [tmp, repo]) if (d) rmSync(d, { recursive: true, force: true }); });

test('by the key, by the issue, and by the commit hung on the card', async () => {
  task(1); task(2, 'review', { issue: 77 }); task(4, 'ready');
  commit('fix the login (DM-1)');
  commit('another (lamaohub/server-comp#77)');
  const t = await look();
  assert.equal(t['DM-1'], 'main');
  assert.equal(t['DM-2'], 'main');
  assert.equal(t['DM-4'], 'none', 'a task with no commit');
});

test('a commit hung on the card proves nothing: without an issue the board hangs the latest commit of the project', async () => {
  const third = task(3);
  commit('work of another task (DM-1)');
  const hash = commit('a message that names no task');
  db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'git', ?)").run(third, `${hash.slice(0, 10)} a message\n1 file changed`);
  assert.equal((await look())['DM-3'], 'none', 'the head of the project read as the commit of the task');
});

test('a commit on a branch only is said so, and a key is not a part of a longer one', async () => {
  task(5); task(50);
  git('checkout', '-q', '-b', 'claude/work');
  commit('half of it (DM-50)');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-50'], 'branch');
  assert.equal(t['DM-5'], 'none', 'DM-50 was read as DM-5');
});

test('a cherry-picked copy on main: the original left on its branch does not count as unshipped', async () => {
  task(6);
  git('checkout', '-q', '-b', 'claude/picked');
  const h = commit('picked work (DM-6)');
  git('checkout', '-q', 'main');
  commit('main went on');
  git('cherry-pick', h);
  assert.equal((await look())['DM-6'], 'main');
});

test('partly shipped is not shipped: a later commit still on a branch says branch', async () => {
  task(7);
  commit('first part (DM-7)');
  git('checkout', '-q', '-b', 'claude/more');
  commit('second part (DM-7)');
  git('checkout', '-q', 'main');
  assert.equal((await look())['DM-7'], 'branch');
});

test('the branch of the task counts without the key in any message, whatever its name around the key', async () => {
  task(8); task(14);
  git('checkout', '-q', '-b', 'claude/DM-8');
  commit('no key here');
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'claude/skill-dm-14-a1b2c3');
  commit('nor here');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-8'], 'branch');
  assert.equal(t['DM-14'], 'branch');
});

test('a branch of the task with nothing of its own says nothing: the work may never have been committed', async () => {
  task(9);
  git('branch', 'claude/DM-9');
  assert.equal((await look())['DM-9'], 'none', 'a branch made and left empty read as on main');
});

test('the branch of the task, cherry-picked whole: on main, though the hashes differ', async () => {
  task(15);
  git('checkout', '-q', '-b', 'claude/DM-15');
  const h = commit('no key in it either');
  git('checkout', '-q', 'main');
  commit('main went on'); // within one second a pick on the same parent would be the very same commit
  git('cherry-pick', h);
  assert.equal((await look())['DM-15'], 'main');
});

test('the same subject with another patch is not a copy', async () => {
  task(16);
  commit('fix tests (DM-16)');
  git('checkout', '-q', '-b', 'claude/other');
  commit('fix tests (DM-16)');
  git('checkout', '-q', 'main');
  assert.equal((await look())['DM-16'], 'branch', 'a subject seen on main hid unshipped work');
});

test('a copy under another subject: GitHub adds the number of the pull request', async () => {
  task(17);
  git('checkout', '-q', '-b', 'pr-one');
  commit('single work (DM-17)');
  git('checkout', '-q', 'main');
  commit('main went on');
  git('cherry-pick', 'pr-one');
  git('commit', '-q', '--amend', '-m', 'single work (DM-17) (#12)');
  assert.equal((await look())['DM-17'], 'main', 'only the same subject was compared');
});

test('squashed: a branch of another name, a new subject, and nothing left to carry', async () => {
  task(18); task(19);
  git('checkout', '-q', '-b', 'pr-two');
  commit('part one (DM-18)', 'squashed-a');
  commit('part two (DM-18)', 'squashed-b');
  git('checkout', '-q', 'main');
  commit('main went on');
  git('merge', '-q', '--squash', 'pr-two');
  git('commit', '-q', '-m', 'the whole of it (DM-18) (#13)');
  git('checkout', '-q', '-b', 'claude/DM-19');
  commit('no key here', 'squashed-c');
  commit('nor here', 'squashed-d');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'claude/DM-19');
  git('commit', '-q', '-m', 'all of the nineteenth (#14)');
  const t = await look();
  assert.equal(t['DM-18'], 'main', 'a squash read as only in a branch');
  assert.equal(t['DM-19'], 'main', 'a squash of the branch of the task read as only in a branch');
});

test('a project in a folder with a colon: a squash is seen, and the objects stay', async () => {
  const home = repo;
  const parent = mkdtempSync(join(tmpdir(), 'kb-ship-'));
  repo = join(parent, 'a:b');
  mkdirSync(repo);
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(repo, pid);
  try {
    git('init', '-q', '-b', 'main');
    commit('first');
    task(90);
    git('checkout', '-q', '-b', 'claude/DM-90');
    commit('no key here', 'colon-a');
    commit('nor here', 'colon-b'); // two: one commit squashed keeps its patch, and is found without the tree
    git('checkout', '-q', 'main');
    commit('main went on');
    git('merge', '-q', '--squash', 'claude/DM-90');
    git('commit', '-q', '-m', 'all of it (#15)');
    const count = git('count-objects', '-v');
    assert.equal((await look())['DM-90'], 'main', 'the path was split on its colon: a squash read as only in a branch');
    assert.equal(git('count-objects', '-v'), count);
  } finally {
    repo = home;
    db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(repo, pid);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a line holds two tasks, one of them picked under another subject: each is told by its own commit', async () => {
  task(29); task(30);
  git('checkout', '-q', '-b', 'pr-mixed');
  const first = commit('one thing (DM-29)', 'mixed-a');
  commit('another (DM-30)', 'mixed-b');
  git('checkout', '-q', 'main');
  commit('main went on');
  git('cherry-pick', first);
  git('commit', '-q', '--amend', '-m', 'one thing (DM-29) (#16)');
  const t = await look();
  assert.equal(t['DM-29'], 'main', 'its copy on main was not seen');
  assert.equal(t['DM-30'], 'branch');
});

test('a squash of only a part leaves the branch something to carry', async () => {
  task(20);
  git('checkout', '-q', '-b', 'pr-three');
  commit('first half (DM-20)', 'half-a');
  const left = commit('second half (DM-20)', 'half-b');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', `${left}~1`);
  git('commit', '-q', '-m', 'only the first half (DM-20)');
  assert.equal((await look())['DM-20'], 'branch');
});

test('a pick resolved into a text of its own stays a branch: neither patch nor tree proves it, and a subject never does', async () => {
  task(21);
  writeFileSync(join(repo, 'shared'), 'one\ntwo\nthree\n'); git('add', '-A'); git('commit', '-q', '-m', 'shared file');
  git('checkout', '-q', '-b', 'pr-four');
  writeFileSync(join(repo, 'shared'), 'one\ntwo\nTHREE\n'); git('add', '-A'); git('commit', '-q', '-m', 'edit it (DM-21)');
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'shared'), 'one\nTWO\nthree\n'); git('add', '-A'); git('commit', '-q', '-m', 'the line next to it');
  try { git('cherry-pick', 'pr-four'); assert.fail('the two edits were meant to conflict'); } catch (e) { if (!/CONFLICT|conflict/.test(String(e.stdout) + e.stderr)) throw e; }
  writeFileSync(join(repo, 'shared'), 'one\nTWO\nTHREE\n'); git('add', '-A');
  git('-c', 'core.editor=true', 'cherry-pick', '--continue');
  git('commit', '-q', '--amend', '-m', 'edit it (DM-21) (#15)');
  assert.equal((await look())['DM-21'], 'branch');
});

test('a look is a few git processes, however many commits the side holds', async () => {
  // counted by git itself: a stand-in script on the PATH waits for the system on every new file and starves the tests beside it
  const dir = mkdtempSync(join(tmpdir(), 'kb-git-'));
  const calls = join(dir, 'calls');
  task(22);
  const copies = async (from, to) => {
    git('checkout', '-q', 'many');
    for (let i = from; i < to; i += 1) commit(`step ${i} (DM-22)`, `many-${i}`);
    git('checkout', '-q', 'main');
    commit('main went on');
    for (let i = to - from; i >= 1; i -= 1) git('cherry-pick', `many~${i - 1}`);
  };
  const count = async () => {
    writeFileSync(calls, '');
    process.env.GIT_TRACE = calls;
    try { assert.equal((await look())['DM-22'], 'main'); } finally { delete process.env.GIT_TRACE; }
    return readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('trace: built-in: git ')).length;
  };
  git('branch', 'many');
  await copies(0, 2);
  const few = await count();
  await copies(2, 14);
  const more = await count();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(few > 0 && more <= few + 2, `${few} git processes for 2 commits, ${more} for 14`); // a merge-tree may come or go, nothing per commit
});

test('a number is the issue only with the name of the mirror: #N in a foreign repository is its pull request', async () => {
  const { forgetRepoBase } = await import('../src/repo-base.js');
  task(23, 'review', { issue: 4242 }); task(24, 'review', { issue: 4243 }); const hung = task(25, 'review', { issue: 4244 });
  commit('Merge pull request #4242 from someone/thing');
  commit('work (LamaoHub/Server-Comp#4243)');
  const merge = commit('Merge pull request #4244 from someone/other');
  db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'git', ?)").run(hung, `${merge.slice(0, 10)} Merge pull request #4244`);
  let t = await look();
  assert.equal(t['DM-23'], 'none', 'the pull request of a foreign repository read as the issue');
  assert.equal(t['DM-24'], 'main');
  assert.equal(t['DM-25'], 'none', 'the board hung it by the bare number');
  // the mirror itself: a number there is the issue, and it is what the skill asks to write
  git('remote', 'add', 'origin', 'git@github.com:lamaohub/server-comp.git');
  forgetRepoBase(repo);
  t = await look();
  assert.equal(t['DM-23'], 'main', 'in the mirror itself #N is the issue');
  git('remote', 'remove', 'origin');
  forgetRepoBase(repo);
});

test('a key mentioned by another commit is not a commit of that task', async () => {
  task(26); task(27); task(28);
  commit('shipped (DM-26)');
  git('checkout', '-q', '-b', 'claude/follow-up');
  commit('DM-27 follow-up to DM-26');
  git('commit', '-q', '--allow-empty', '-m', 'a subject of nobody', '-m', 'the body says see DM-28 for why');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-26'], 'main', 'a mention on a branch read as work left on it');
  assert.equal(t['DM-27'], 'branch');
  assert.equal(t['DM-28'], 'none', 'a key in the body is a mention');
});

test('a line that took its work back has not shipped it: a commit and its revert, an empty commit', async () => {
  task(70); task(71);
  git('checkout', '-q', '-b', 'claude/DM-70');
  commit('a try (DM-70)');
  git('revert', '--no-edit', 'HEAD');
  git('checkout', '-q', '-b', 'claude/DM-71', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'nothing in it (DM-71)');
  git('checkout', '-q', 'main');
  const t = await look();
  assert.equal(t['DM-70'], 'branch', 'nothing of it is on main, and the mark said it is');
  assert.equal(t['DM-71'], 'branch', 'an empty commit read as shipped');
});

test('a number at the head of a subject is no key: the key stands after it', async () => {
  task(72); task(73); task(74); task(75);
  commit('Fix 2-3 second delay (DM-72)');
  commit('Move to sha-256 hashes (DM-73)');
  commit('The 2026-11 report (DM-74)');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('sib','SIB','sib',5)").run();
  commit('SIB-3 follow-up to DM-75');
  const t = await look();
  assert.deepEqual([t['DM-72'], t['DM-73'], t['DM-74']], ['main', 'main', 'main'], 'a word that looks like a key took the place of the key');
  assert.equal(t['DM-75'], 'none', 'a key of another project on the board still comes first');
});

test('a look leaves the objects of the project as they were, and nothing of its own behind', async () => {
  const objects = () => readdirSync(join(repo, '.git', 'objects'), { recursive: true }).sort();
  task(76);
  git('checkout', '-q', '-b', 'claude/DM-76');
  commit('one (DM-76)', 'sq76a');
  commit('two (DM-76)', 'sq76b');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'claude/DM-76');
  git('commit', '-q', '-m', 'the feature (#76)');
  commit('main went on'); // a merge of the line into this main makes a tree nobody has yet
  const line = 'claude/DM-76';
  assert.equal(git('merge-tree', '--write-tree', '--no-messages', 'main', line).split('\n')[0], git('rev-parse', 'main^{tree}'), 'the case itself');
  const before = objects();
  const held = process.env.TMPDIR;
  const scratch = mkdtempSync(join(tmp, 'tmp-'));
  process.env.TMPDIR = scratch;
  try {
    assert.equal((await look())['DM-76'], 'main', 'the squash stopped being read');
    assert.deepEqual(objects(), before, 'a look wrote into the repository of the project');
    assert.deepEqual(readdirSync(scratch), [], 'a look left its directory behind');
    chmodSync(join(repo, '.git', 'objects'), 0o555);
    assert.equal((await look())['DM-76'], 'main', 'a repository the board may not write to');
  } finally {
    chmodSync(join(repo, '.git', 'objects'), 0o755);
    if (held === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = held;
  }
});

test('the keys a subject claims for itself, and how a word is cut out of it', async () => {
  const { mirrorName, ownKeys, parseLog } = await import('../src/shipped.js');
  const cases = [
    ['SHI-108 follow-up to SHI-107', ['SHI-108']],
    ['SHI-108: fix', ['SHI-108']],
    ['[SHI-108] fix, see SHI-1', ['SHI-108']],
    ['SHI-1, SHI-2 and SHI-3: both', ['SHI-1', 'SHI-2', 'SHI-3']],
    ['fix the login (DM-1)', ['DM-1']],
    ['What the review found (CK-894, CK-895, CK-934): more about CK-1', ['CK-894', 'CK-895', 'CK-934']],
    ['villa: VT-572, VT-412 (acceptance of VT-627): a word', ['VT-572', 'VT-412']],
    ['Fix CK-7', ['CK-7']],
    ["Merge branch 'claude/DM-5-a1' into dev", ['DM-5']],
    ['no key at all', []],
  ];
  for (const [subject, keys] of cases) assert.deepEqual(ownKeys(subject), keys, subject);
  const words = (s) => [...parseLog(`abc\n\n${s}\n${s}\x1e`)[0].words];
  assert.deepEqual(words('2K-1 starts with a digit'), ['2K-1'], 'the prefix was cut at its digit');
  assert.deepEqual(words('fix (acme/app.js#12, #13)'), ['ACME/APP.JS#12', '#13']);
  assert.deepEqual(['one', 'acme/app'].map((r) => mirrorName('acme', r)), ['acme/one', 'acme/app'], 'gh.repo holds either form');
  assert.equal(mirrorName('', ''), '');
});

test('a task done by hand and a check say nothing, nor a task out of these columns', async () => {
  task(10, 'review', { labels: '["noclaude"]' }); task(11, 'review', { labels: '["check"]' }); task(12, 'doing');
  commit('work (DM-12)');
  const t = await look();
  assert.deepEqual(['DM-10', 'DM-11', 'DM-12'].filter((k) => k in t), []);
});

test('origin/main is what counts when there is one', async () => {
  task(13);
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  commit('local only (DM-13)');
  assert.equal((await look())['DM-13'], 'branch', 'a commit not pushed reads as on main');
  git('update-ref', '-d', 'refs/remotes/origin/main');
});

test('a folder that is not a repository, or no folder: no word at all', async () => {
  const other = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('plain','PL','plain',5,?)").run(tmp).lastInsertRowid;
  const none = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('nopath','NP','nopath',5)").run().lastInsertRowid;
  for (const id of [other, none]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'review')").run(id);
  assert.deepEqual(await look('?project=plain'), {});
  assert.deepEqual(await look('?project=nopath'), {});
  const all = await look('');
  assert.equal(all['DM-1'], 'main', 'all the boards together');
});

test('an answer lives a while: two looks are one', async () => {
  const { shippedOf } = await import('../src/shipped.js');
  forgetShipped();
  const p = { id: pid, path: repo };
  const one = shippedOf(p, 1000);
  assert.equal(one, shippedOf(p, 2000));
  const later = shippedOf(p, 40000);
  assert.notEqual(one, later);
  await Promise.all([one, later]);
  forgetShipped();
});

test('a branch is the task\'s by the key as a word of its name', async () => {
  const { branchesOf, cherryState } = await import('../src/shipped.js');
  const names = ['claude/CK-5', 'origin/claude/ck-5', 'claude/skill-ck-5-ab12', 'claude/CK-50', 'claude/xck-5', 'claude/ck-5x'];
  assert.deepEqual(branchesOf('CK-5', names), ['claude/CK-5', 'origin/claude/ck-5', 'claude/skill-ck-5-ab12']);
  assert.equal(cherryState(''), null);
  assert.equal(cherryState('- abc\n- def\n'), 'in');
  assert.equal(cherryState('- abc\n+ def\n'), 'ahead');
});

test('the page asks about the board it shows: a board opened while a question flies is asked about as that one lands', async () => {
  let slug = 'alpha'; const asked = []; const waiting = []; const applied = [];
  const ask = shipAsker({ every: 30000, board: () => slug, wanted: () => true, now: () => 1000,
    ask: (s) => { asked.push(s); return new Promise((resolve) => { waiting.push(resolve); }); }, apply: (r) => applied.push(r) });
  ask();
  slug = 'beta';
  ask(); // the render of the new board: the question of the old one still flies
  assert.deepEqual(asked, ['alpha']);
  waiting[0]('for alpha');
  await new Promise((r) => { setTimeout(r, 5); });
  assert.deepEqual(asked, ['alpha', 'beta'], 'the new board stayed without its marks');
  assert.deepEqual(applied, [], 'the answer about the board left was applied');
  waiting[1]('for beta');
  await new Promise((r) => { setTimeout(r, 5); });
  assert.deepEqual(applied, ['for beta']);
  ask();
  assert.equal(asked.length, 2, 'within the pause there is no second question');
});

test('what the card and the filter go by', () => {
  assert.equal(showsShip('review'), true);
  assert.equal(showsShip('ready'), true);
  assert.equal(showsShip('doing'), false);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'main' }), false);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'branch' }), true);
  assert.equal(notOnMain({ key: 'A-1' }, { 'A-1': 'none' }), true);
  assert.equal(notOnMain({ key: 'A-1' }, {}), true, 'not looked at yet is not known to be there');
  assert.deepEqual(Object.keys(SHIP_WORDS).sort(), ['branch', 'main', 'none']);
});

// branch was a `git cherry` again on every look, 30 s apart
const traced = async (url, keep = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-git-'));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  forgetShipped(keep);
  process.env.GIT_TRACE = calls;
  try {
    const tasks = (await app.inject({ method: 'GET', url })).json().tasks;
    const run = readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('trace: built-in: git '));
    return { tasks, count: (what) => run.filter((l) => l.includes(`built-in: git ${what}`)).length };
  } finally { delete process.env.GIT_TRACE; rmSync(dir, { recursive: true, force: true }); }
};

test('projects in one repository read its history once, and every one of them is answered', async () => {
  mkdirSync(join(repo, 'two'), { recursive: true });
  const two = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('two','TW','two',100,?)").run(join(repo, 'two')).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, 7, 'T', 'review', '[]')").run(two);
  commit('TW-7 a task of the folder');
  task(31);
  commit('DM-31 a task of the root');
  const { tasks, count } = await traced('/api/shipped');
  assert.equal(tasks['TW-7'], 'main');
  assert.equal(tasks['DM-31'], 'main');
  assert.equal(count('log'), 2, 'the history of the repository was read for each of its projects');
});

test('a task branch is asked again only when main or the branch moved', async () => {
  task(40);
  git('checkout', '-q', '-b', 'claude/DM-40');
  commit('DM-40 work on its branch');
  git('checkout', '-q', 'main');
  const first = await traced('/api/shipped?project=demo');
  assert.equal(first.tasks['DM-40'], 'branch');
  assert.ok(first.count('cherry') >= 1);
  const again = await traced('/api/shipped?project=demo', { lines: false });
  assert.equal(again.tasks['DM-40'], 'branch');
  assert.equal(again.count('cherry'), 0, 'a branch was compared with main again, though neither moved');
  git('checkout', '-q', 'claude/DM-40');
  commit('DM-40 more work');
  git('checkout', '-q', 'main');
  git('cherry-pick', 'claude/DM-40~1', 'claude/DM-40');
  const moved = await traced('/api/shipped?project=demo', { lines: false });
  assert.equal(moved.tasks['DM-40'], 'main', 'an answer kept from before main moved');
  assert.ok(moved.count('cherry') >= 1);
  git('branch', '-D', 'claude/DM-40');
});

// green — a task brought to main while its branch stands (cherry-pick, a merge) said «branch» for good
test('main moved, the branch standing: the task brought to main is on main', async () => {
  task(43);
  git('checkout', '-q', '-b', 'claude/DM-43');
  commit('DM-43 work on its branch', 'dm-43-file');
  git('checkout', '-q', 'main');
  assert.equal((await traced('/api/shipped?project=demo')).tasks['DM-43'], 'branch');
  const tip = git('rev-parse', 'claude/DM-43');
  git('cherry-pick', 'claude/DM-43');
  assert.equal(git('rev-parse', 'claude/DM-43'), tip, 'the branch moved');
  const moved = await traced('/api/shipped?project=demo', { lines: false });
  assert.equal(moved.tasks['DM-43'], 'main', 'an answer kept from before main moved, the branch standing');
  git('branch', '-D', 'claude/DM-43');
});

test('a branch with no commit of its own is answered without git cherry', async () => {
  task(41);
  git('branch', 'claude/DM-41');
  const tip = git('rev-parse', 'claude/DM-41');
  const { tasks, count } = await traced('/api/shipped?project=demo');
  assert.equal(tasks['DM-41'], 'none');
  assert.equal(count(`cherry ${tip} ${tip}`), 0, 'a branch with nothing of its own went through git cherry');
  assert.equal(count(`rev-list --count ${tip}..${tip}`), 1);
  git('branch', '-D', 'claude/DM-41');
});

test('a branch git did not answer for is asked again on the next look, not kept', async () => {
  task(42);
  git('checkout', '-q', '-b', 'claude/DM-42');
  const tip = commit('DM-42 work on its branch', 'dm-42-file');
  git('checkout', '-q', 'main');
  // the tree of the tip gone for one look: rev-list walks commits and answers, git cherry reads the patch and fails
  const blob = git('rev-parse', `${tip}^{tree}`);
  const file = join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  const aside = `${file}.aside`;
  renameSync(file, aside);
  let first;
  try { first = await traced('/api/shipped?project=demo'); } finally { renameSync(aside, file); }
  assert.equal(first.tasks['DM-42'], 'branch');
  assert.ok(first.count(`cherry`) >= 1);
  const again = await traced('/api/shipped?project=demo', { lines: false });
  assert.ok(again.count(`cherry `) >= 1 && again.tasks['DM-42'] === 'branch', 'a line git failed to answer was kept as answered');
  const kept = await traced('/api/shipped?project=demo', { lines: false });
  assert.equal(kept.count(`cherry `), 0, 'an answered line is kept');
  git('branch', '-D', 'claude/DM-42');
});
