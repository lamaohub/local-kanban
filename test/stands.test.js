// repository with an origin, a worktree in each state the section tells apart, and the real routes over a database of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath, onPath } from '../src/bin-path.js';

let tmp, repo, app, db, stands, host, sleeper, objectsBefore;
const wt = (name) => join(repo, '.claude', 'worktrees', name);
const git = (dir, ...args) => execFileSync(fullPath('git'), ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
function commit(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}
function stand(name, branch) {
  git(repo, 'worktree', 'add', '-q', wt(name), '-b', branch);
  return wt(name);
}

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-stands-')));
  repo = join(tmp, 'repo');
  const origin = join(tmp, 'origin.git');
  mkdirSync(repo);
  git(tmp, 'init', '-q', '--bare', origin);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'a.txt', 'one\n', 'start');
  writeFileSync(join(repo, '.gitignore'), '.claude/\n.env\nnode_modules/\ndata/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-q', '-m', 'ignore the stands');
  git(repo, 'remote', 'add', 'origin', origin);

  // a commit cherry-picked into main: the same patch
  const picked = commit(stand('STA-1', 'claude/STA-1'), 'p.txt', 'picked\n', 'Picked work (STA-1)');
  // the same title in main, other content: a batch that landed as a rework
  commit(stand('retitled-9f3e1a', 'claude/retitled'), 'r.txt', 'mine\n', 'Same title in main');
  // a commit whose issue is named in main by another commit (a squash of the batch)
  commit(stand('issued', 'claude/issued'), 'i.txt', 'mine\n', 'Part of a batch (o/r#77)');
  // work found nowhere in main
  commit(stand('lost', 'claude/lost'), 'l.txt', 'lost\n', 'Work not handed in (o/r#78)');
  // nothing committed, but a file left in the folder
  writeFileSync(join(stand('dirty', 'claude/dirty'), 'notes.txt'), 'draft\n');
  // the task of its key is in work
  stand('sta-2-busy', 'claude/STA-2');
  // a process stands in the folder (a stand of a server)
  const proc = stand('served', 'claude/served');
  // nothing at all: a clean branch at main
  stand('empty', 'claude/empty');
  // `git branch -d master` — such a branch is never a stand to remove
  stand('on-master', 'master');
  // the folder deleted by hand, its branch with work not in main (a prunable worktree)
  commit(stand('gone', 'claude/gone'), 'g.txt', 'gone\n', 'Work left on a branch whose folder went');
  rmSync(wt('gone'), { recursive: true, force: true });
  // a title that says nothing is in any log: «WIP» in main proves nothing about this one
  commit(stand('wip', 'claude/wip'), 'w.txt', 'mine\n', 'WIP');
  // of the first vouched for the second
  const halfDir = stand('half', 'claude/half');
  const halfIn = commit(halfDir, 'h1.txt', 'in\n', 'The first half of the work (o/r#110)');
  commit(halfDir, 'h2.txt', 'out\n', 'The second half, never in main (o/r#110)');
  // the same change landed inside a bigger squash: another patch, the same result
  commit(stand('squashed', 'claude/squashed'), 'q.txt', 'squashed\n', 'A change that landed in a squash');
  // ignored files: a .env and a database the main checkout lacks — `git worktree remove` would delete them
  const kept = stand('kept-data', 'claude/kept-data');
  writeFileSync(join(kept, '.env'), 'SECRET=1\n');
  mkdirSync(join(kept, 'data'));
  writeFileSync(join(kept, 'data', 'app.db'), 'rows\n');
  // a name in Cyrillic: git quotes it unless asked for -z, and a quoted name is found nowhere
  const cyr = stand('cyr-data', 'claude/cyr-data');
  mkdirSync(join(cyr, 'data'));
  writeFileSync(join(cyr, 'data', '\u043e\u0442\u0447\u0451\u0442.txt'), 'notes\n');
  // what an install makes again, the settings of a Claude session, and data the main checkout holds byte for byte
  const cache = stand('cache', 'claude/cache');
  mkdirSync(join(cache, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(cache, 'node_modules', 'x', 'i.js'), 'x\n');
  mkdirSync(join(cache, '.claude'));
  writeFileSync(join(cache, '.claude', 'settings.local.json'), '{}\n');
  mkdirSync(join(repo, 'data'));
  writeFileSync(join(repo, 'data', 'seed.json'), '[1]\n');
  mkdirSync(join(cache, 'data'));
  writeFileSync(join(cache, 'data', 'seed.json'), '[1]\n');
  // which `git worktree remove` takes only the link of: no reason to keep the stand
  writeFileSync(join(repo, 'data', 'linked.db'), 'the owner\'s rows\n');
  symlinkSync(join(repo, 'data', 'linked.db'), join(cache, 'data', 'linked.db'));
  // a Claude session works in the folder
  stand('sessioned', 'claude/sessioned');
  // an empty commit merges to main's tree like work that landed: it proves nothing
  git(stand('emptied', 'claude/emptied'), 'commit', '-q', '--allow-empty', '-m', 'Notes on the work, nothing changed');
  // a database over a megabyte: the same bytes as the main checkout's but for the last one — compared to the end
  const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  writeFileSync(join(repo, 'data', 'big.db'), big);
  writeFileSync(join(cache, 'data', 'big.db'), big);
  // with a fix of its own made while merging is (merged below, once main has moved)
  const mergedClean = stand('merged-clean', 'claude/merged-clean');
  const mergedEvil = stand('merged-evil', 'claude/merged-evil');
  const tail = stand('tail-data', 'claude/tail-data');
  mkdirSync(join(tail, 'data'));
  writeFileSync(join(tail, 'data', 'big.db'), Buffer.concat([big.subarray(0, big.length - 1), Buffer.from([8])]));

  // main moves on first: a cherry-pick onto the same parent in the same second would make the very same commit
  commit(repo, 'r2.txt', 'theirs\n', 'Same title in main');
  git(repo, 'cherry-pick', picked);
  commit(repo, 'b.txt', 'batch\n', 'The batch, squashed (o/r#77, o/r#79)');
  git(repo, 'cherry-pick', halfIn);
  writeFileSync(join(repo, 'q.txt'), 'squashed\n');
  writeFileSync(join(repo, 'q2.txt'), 'more of the squash\n');
  git(repo, 'add', 'q.txt', 'q2.txt'); git(repo, 'commit', '-q', '-m', 'Several tasks in one squash');
  commit(repo, 'w2.txt', 'theirs\n', 'WIP');
  git(mergedClean, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  git(mergedEvil, 'merge', '-q', '--no-ff', '--no-commit', 'main');
  writeFileSync(join(mergedEvil, 'evil.txt'), 'made while merging\n');
  git(mergedEvil, 'add', 'evil.txt');
  git(mergedEvil, 'rm', '-q', '-f', 'r2.txt'); // a change of main undone while merging: the merge equals one parent there
  git(mergedEvil, 'commit', '-q', '-m', 'Merge main into the branch');
  git(repo, 'push', '-q', 'origin', 'main');
  // more merges than the board merges again (MERGES_MAX = 200): the ones past the bound are no proof — «could not tell»,
  // not «nothing to lose». Clean merges of an old commit of main, made by git commit-tree (a second each would be slow)
  const many = stand('many-merges', 'claude/many-merges');
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
  const tree = git(many, 'rev-parse', 'HEAD^{tree}').trim();
  let tip = git(many, 'rev-parse', 'HEAD').trim();
  for (let i = 0; i < 201; i += 1) tip = git(many, 'commit-tree', tree, '-p', tip, '-p', root, '-m', `Merge ${i}`).trim();
  git(many, 'reset', '-q', '--hard', tip);
  // (refs/heads before refs/remotes) — every stand was measured against the first commit
  git(repo, 'branch', 'origin/main', git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim());
  sleeper = spawn('/bin/sleep', ['60'], { cwd: proc, stdio: 'ignore' });
  objectsBefore = git(repo, 'count-objects', '-v');

  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_CLAUDE_DIR = join(tmp, 'claude');
  mkdirSync(join(tmp, 'claude', 'sessions'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: '0f0e0d0c-0b0a-4909-8807-060504030201', pid: process.pid, status: 'busy', cwd: wt('sessioned') }));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  stands = await import('../src/stands.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sta', 'STA', 'Stands', ?, 3)").run(repo).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Picked', 'review'), (?, 2, 'Busy', 'doing')").run(pid, pid);
  app = Fastify();
  const { PORT } = await import('../src/config.js');
  host = `127.0.0.1:${PORT}`;
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/health.js')).default);
  await app.ready();
});
after(async () => {
  sleeper?.kill('SIGKILL');
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const get = async (url) => (await app.inject({ method: 'GET', url, headers: { host } }));
async function walked() {
  await get('/api/health/stands');
  await stands.standsSettled();
  return (await get('/api/health/stands')).json();
}

test('each stand reads as free, not handed in, or busy — by its folder, its commits against origin/main and its task', async () => {
  const d = await walked();
  assert.equal(d.running, false);
  assert.equal(d.repos.length, 1);
  assert.equal(d.repos[0].main, 'origin/main');
  assert.equal(d.repos[0].ref, 'refs/remotes/origin/main', 'main is named by its short name, which a local branch «origin/main» takes over');
  const by = Object.fromEntries(d.stands.map((s) => [s.path.split('/').pop(), s]));
  assert.deepEqual(Object.keys(by).sort(), ['STA-1', 'cache', 'cyr-data', 'dirty', 'emptied', 'empty', 'gone', 'half', 'issued', 'kept-data', 'lost', 'many-merges', 'merged-clean', 'merged-evil', 'on-master', 'retitled-9f3e1a', 'served', 'sessioned', 'squashed', 'sta-2-busy', 'tail-data', 'wip'], 'the main checkout is no stand');
  assert.equal(by.gone.state, 'unsent', 'a stand whose folder went read as free, its branch never compared with main');
  assert.deepEqual(by.gone.why, ['commits']);
  assert.equal(by.wip.state, 'unsent', '«WIP» in main read as this very work');
  assert.equal(by['STA-1'].state, 'free', `measured against the local branch «origin/main»: ${JSON.stringify(by['STA-1'].commits)}`);
  assert.equal(by['STA-1'].commits[0].found, 'patch');
  assert.equal(by['merged-clean'].state, 'free', `a merge that caught main up read as work: ${JSON.stringify(by['merged-clean'].commits)}`);
  assert.equal(by['merged-evil'].state, 'unsent', 'a merge with a change of its own read as nothing to lose — git cherry passes merges over');
  assert.deepEqual(by['merged-evil'].why, ['merge']);
  assert.equal(by['many-merges'].state, 'unsent', 'merges past the bound, never merged again, read as nothing to lose');
  assert.deepEqual(by['many-merges'].why, ['unknown']);
  assert.deepEqual(by['merged-evil'].commits.map((c) => [c.title, c.found, Boolean(c.merge)]), [['Merge main into the branch', null, true]]);
  assert.equal(by['STA-1'].key, 'STA-1');
  assert.equal(by['STA-1'].task.status, 'review');
  // a title or an issue in main is a hint, not a proof: the changes of these two are in main nowhere
  assert.equal(by['retitled-9f3e1a'].state, 'unsent', 'the same title in main vouched for other changes');
  assert.deepEqual([by['retitled-9f3e1a'].commits[0].found, by['retitled-9f3e1a'].commits[0].like], [null, 'title']);
  assert.equal(by['retitled-9f3e1a'].key, null, 'a hash tail read as a key');
  assert.equal(by.issued.state, 'unsent', 'the issue of a squash vouched for a file it never had');
  assert.deepEqual([by.issued.commits[0].found, by.issued.commits[0].like], [null, 'issue']);
  assert.equal(by.half.state, 'unsent', 'one commit of a task in main vouched for the rest of its branch');
  assert.deepEqual(by.half.commits.map((c) => [c.title.slice(0, 10), c.found, c.like]).sort(), [['The first ', 'patch', null], ['The second', null, 'issue']].sort());
  assert.equal(by.squashed.state, 'free', 'a change that landed in a squash read as not in main');
  assert.equal(by.squashed.commits[0].found, 'content');
  assert.equal(by['kept-data'].state, 'unsent', 'a .env and a database the main checkout lacks read as nothing to lose');
  assert.deepEqual(by['kept-data'].why, ['ignored']);
  assert.deepEqual(by['kept-data'].ignored.paths.sort(), ['.env', 'data/app.db']);
  assert.equal(by['cyr-data'].state, 'unsent', 'an ignored file named in Cyrillic was not found and read as nothing');
  assert.deepEqual(by['cyr-data'].why, ['ignored']);
  assert.equal(by.cache.state, 'free', `node_modules, the settings of a session or data the main checkout holds kept a stand: ${JSON.stringify(by.cache.ignored)}`);
  assert.equal(git(repo, 'count-objects', '-v'), objectsBefore, 'a look wrote objects into the repository of the owner');
  assert.equal(by.emptied.state, 'unsent', 'an empty commit read as its changes in main');
  assert.equal(by.emptied.commits[0].found, null);
  assert.equal(by['tail-data'].state, 'unsent', 'a database differing past its first megabyte read as the main checkout\'s');
  assert.deepEqual(by['tail-data'].ignored.paths, ['data/big.db']);
  assert.equal(by.sessioned.state, 'busy', 'a Claude session in the folder does not hold it');
  assert.deepEqual(by.sessioned.why, ['session']);
  assert.equal(by.empty.state, 'free');
  assert.equal(by['on-master'].state, 'busy', 'a worktree on master read as a stand to remove — the cleanup would delete the branch');
  assert.deepEqual(by['on-master'].why, ['main']);
  assert.equal(by.lost.state, 'unsent');
  assert.deepEqual(by.lost.why, ['commits']);
  assert.equal(by.dirty.state, 'unsent');
  assert.deepEqual(by.dirty.why, ['dirty']);
  assert.equal(by['sta-2-busy'].state, 'busy');
  assert.deepEqual(by['sta-2-busy'].why, ['task']);
  assert.equal(by.served.state, 'busy', 'a process in the folder does not hold it');
  assert.deepEqual(by.served.why, ['process']);
  assert.ok(by.served.size > 0 && by['STA-1'].changed_at > 0, 'the size and the date are not measured');
});

test('the task of a cleanup takes only the free stands, names the others for the owner, and says how to check each again', async () => {
  const d = (await get('/api/health/stands')).json();
  const r = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: d.stands.map((s) => s.path) } });
  assert.equal(r.statusCode, 200, r.body);
  const [t] = r.json().tasks;
  assert.equal(r.json().tasks.length, 1);
  assert.equal(t.n, 5);  // STA-1, squashed, cache, empty, merged-clean
  const task = db.prepare("SELECT t.status, t.description FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(t.key);
  assert.equal(task.status, 'todo');
  for (const name of ['STA-1', 'squashed', 'cache', 'empty', 'merged-clean']) assert.ok(task.description.includes(`${wt(name)} —`), `${name} is not in the task`);
  for (const name of ['served', 'sta-2-busy', 'sessioned', 'on-master']) assert.ok(!task.description.includes(wt(name)), `a busy stand ${name} got into the task`);
  for (const name of ['kept-data', 'half', 'issued', 'merged-evil']) assert.ok(!task.description.includes(`${wt(name)} —`), `${name} got into the task to be removed`);
  const asks = task.description.slice(task.description.lastIndexOf('\n\n', task.description.indexOf(wt('lost'))));
  assert.ok(asks.includes(wt('lost')) && asks.includes(wt('dirty')), 'the stands with work not in main are not named for the owner');
  // the board speaks Russian here (uiLang): the list and the reasons in Russian, not «branch», «MB» or a code
  const evilAsk = asks.split('\n').find((l) => l.startsWith(`- ${wt('merged-evil')} `));
  assert.ok(evilAsk?.endsWith('\u0441\u043b\u0438\u044f\u043d\u0438\u0435 \u0441\u043e \u0441\u0432\u043e\u0438\u043c\u0438 \u043f\u0440\u0430\u0432\u043a\u0430\u043c\u0438'), `the evil merge is not named for the owner in words: ${evilAsk}`);
  const listed = task.description.split('\n').find((l) => l.startsWith(`- ${wt('cache')} `));
  assert.match(listed, /\u2014 \u0432\u0435\u0442\u043a\u0430 claude\/cache/, `a Russian task lists «branch»: ${listed}`);
  assert.match(listed, / \d+ \u041c\u0411/, `a Russian task weighs in MB: ${listed}`);
  assert.match(task.description, /git worktree remove/);
  assert.match(task.description, /git branch -d/);
  assert.match(task.description, /--force/, 'the task does not forbid --force');
  // pressed again with the task still in To do — the same task, written anew
  const again = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [wt('empty')] } });
  assert.equal(again.json().tasks[0].key, t.key);
  // in work — a refusal that names it
  db.prepare("UPDATE tasks SET status = 'doing' WHERE task_no = ? AND project_id = (SELECT id FROM projects WHERE slug = 'sta')").run(Number(t.key.split('-')[1]));
  const held = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [wt('empty')] } });
  assert.equal(held.statusCode, 409);
  assert.equal(held.json().reason, 'cleanup-open');
  assert.equal(held.json().key, t.key);
  const none = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [wt('lost'), wt('served'), '/etc'] } });
  assert.equal(none.statusCode, 409);
  assert.equal(none.json().reason, 'nothing-free', 'a stand with work not in main, a busy one, or a made-up folder got into a task');
});

test('the diff of a stand shows what is not in main, and only for a folder of the last look', async () => {
  const lost = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('lost'))}`)).json();
  assert.match(lost.text, /Work not handed in/);
  assert.match(lost.text, /\+lost/);
  const kept = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('kept-data'))}`)).json();
  assert.match(kept.text, /data\/app\.db/, 'the diff does not name the ignored data a removal would delete');
  assert.doesNotMatch(kept.text, /# ignored/, `a Russian board got English headings: ${kept.text}`);
  assert.match(kept.text, /^# \u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0435\u0442\u0441\u044f/m);
  assert.match((await stands.standDiff(wt('kept-data'), 'en')).text, /# ignored, and not in the main checkout/);
  assert.match((await stands.standDiff(wt('dirty'), 'en')).text, /# not committed/);
  // a merge shows its own change, not the whole of main it brought in
  const evil = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('merged-evil'))}`)).json();
  assert.match(evil.text, /\+made while merging/, 'the change made while merging is not in the diff');
  assert.doesNotMatch(evil.text, /\+batch|\+theirs/, 'the diff of a merge shows the commits of main it brought in');
  assert.match(evil.text, /^-theirs$/m, 'a change of main undone while merging is not in the diff (a combined diff hides what equals one parent)');
  assert.equal(git(repo, 'count-objects', '-v'), objectsBefore, 'the diff of a merge wrote objects into the repository of the owner');
  const half = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('half'))}`)).json();
  assert.match(half.text, /\+out/, 'the diff hides the commit vouched for by the issue of another');
  const dirty = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('dirty'))}`)).json();
  assert.match(dirty.text, /notes\.txt/);
  assert.doesNotMatch(dirty.text, /# not committed|# untracked/, `a Russian board got English headings: ${dirty.text}`);
  assert.equal((await get(`/api/health/stands/diff?path=${encodeURIComponent(repo)}`)).statusCode, 404, 'the main checkout is no stand');
  assert.equal((await get('/api/health/stands/diff?path=/etc')).statusCode, 404);
  assert.equal((await get('/api/health/stands/diff?path=a&path=b')).statusCode, 400);
});

test('the stands are the owner\'s: a guest of the Wi-Fi door gets none of them', async () => {
  const { ownerOnly } = await import('../src/share.js');
  assert.ok(ownerOnly('GET', '/api/health/stands'));
  assert.ok(ownerOnly('GET', '/api/health/stands/diff'));
  assert.ok(ownerOnly('POST', '/api/health/stands/task'));
  assert.ok(!ownerOnly('GET', '/api/health'), 'the sizes of CLAUDE.md went owner-only too');
});

test('a project added since the walk is walked at the next look, not ten minutes later', async () => {
  const other = join(tmp, 'other');
  mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  commit(other, 'o.txt', 'o\n', 'start');
  git(other, 'worktree', 'add', '-q', join(other, 'wt-x'), '-b', 'claude/x');
  const before = (await get('/api/health/stands')).json();
  assert.equal(before.running, false);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('oth', 'OTH', 'Other', ?, 1)").run(other);
  assert.equal((await get('/api/health/stands')).json().running, true, 'the new project waited for the picture to age');
  await stands.standsSettled();
  const d = (await get('/api/health/stands')).json();
  assert.equal(d.repos.length, 2);
  assert.ok(d.stands.some((s) => s.path === join(other, 'wt-x')));
  // the cleanup of the first repository is in work (the test above): a choice over both repositories is refused whole —
  // no task is opened for the second one that the page would then never start
  const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const r = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [join(other, 'wt-x'), wt('empty')] } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'cleanup-open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, tasksBefore, 'a task was opened before the refusal');
});

test('a second project of the same repository finds the cleanup already open in the first one', async () => {
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sta2', 'STB', 'Stands too', ?, 1)").run(join(repo, 'sub'));
  mkdirSync(join(repo, 'sub'), { recursive: true });
  await get('/api/health/stands');
  await stands.standsSettled();
  const d = (await get('/api/health/stands')).json();
  assert.equal(d.repos.find((r) => r.top === repo).projects.length, 2);
  const r = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [wt('empty')] } });
  assert.equal(r.json().reason, 'cleanup-open', 'a second cleanup of one repository was opened in its other project');
});

test('the rules by themselves: worktrees, keys, issues and the match of commits', () => {
  const list = stands.parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/w\nHEAD 2\ndetached\nlocked held\n\nworktree /r/x\nHEAD 3\nbranch refs/heads/claude/X-1\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(list.map((w) => [w.path, w.branch ?? null, Boolean(w.detached), w.locked ?? null, Boolean(w.prunable)]),
    [['/r', 'main', false, null, false], ['/r/w', null, true, 'held', false], ['/r/x', 'claude/X-1', false, null, true]]);
  const prefixes = new Set(['CK', 'IB']);
  assert.equal(stands.keyIn(['ck-559-kanban-task-0e9ea3'], prefixes), 'CK-559');
  assert.equal(stands.keyIn(['apartment-inventory-pdf-ee85f1', 'claude/IB-830'], prefixes), 'IB-830');
  assert.equal(stands.keyIn(['ab-12f4e1'], new Set(['AB'])), null, 'a hash read as a key');
  assert.equal(stands.keyIn(['zz-12'], prefixes), null, 'a prefix of no project read as a key');
  assert.deepEqual(stands.issuesIn('Fix (lamaohub/server-comp#6144, lamaohub/server-comp#6145) #12'), ['6144', '6145']);
  const main = { titles: new Set(['The same work by its title']), issues: new Set(['1', '2']) };
  const msgs = new Map([['aaaaaaa', { title: 'The same work by its title', body: '' }], ['bbbbbbb', { title: 'U (o/r#1, o/r#3)', body: '' }], ['ccccccc', { title: 'V (o/r#2)', body: '' }], ['ddddddd', { title: 'W (o/r#2)', body: '' }]]);
  assert.deepEqual(stands.matchCommits('- 1111111\n+ aaaaaaa\n+ bbbbbbb\n+ ccccccc\n+ ddddddd\n', msgs, main, new Set(['ddddddd'])).map((c) => [c.found, c.like ?? null]),
    [['patch', null], [null, 'title'], [null, null], [null, 'issue'], ['content', null]], 'a title or an issue in main read as the changes in main, or one issue of two as a hint');
  assert.equal(stands.regenerable('node_modules/'), true);
  assert.equal(stands.regenerable('app/node_modules/x/i.js'), true);
  assert.equal(stands.regenerable('.claude/settings.local.json'), true);
  assert.equal(stands.regenerable('.DS_Store'), true);
  for (const p of ['.env', 'data/', 'var/', 'app/data/app.db', '.claude/skills/x/SKILL.md', 'notes.log']) assert.equal(stands.regenerable(p), false, `${p} read as made again by a build`);
  assert.deepEqual(stands.parseStatusZ('?? a b.txt\0R  new.txt\0old.txt\0!! data/\u043e.txt\0!! .env\0'), { changed: ['?? a b.txt', 'R  new.txt'], ignored: ['data/\u043e.txt', '.env'] });
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], sessions: 0, processes: 0, ignored: { files: 2, paths: [] } }).why, ['ignored']);
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], sessions: 0, processes: 0, ignored: null }).why, ['unknown'], 'ignored files not looked at read as none');
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], locked: 'x', sessions: 0, processes: 0 }).why, ['locked']);
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], sessions: 0, processes: null }).why, ['unknown'], 'lsof that did not answer read as «no process»');
  assert.equal(stands.telling('WIP'), false);
  assert.equal(stands.telling('Fix tests'), false);
  assert.equal(stands.telling('Same title in main'), true);
  assert.equal(stands.standState({ read: false }).state, 'reading');
  const at = (status) => stands.standState({ read: true, dirty: 0, commits: [], sessions: 0, processes: 0, ignored: { files: 0 }, task: { status } });
  for (const st of ['prep', 'doing', 'ready', 'deploy']) assert.deepEqual([at(st).state, at(st).why], ['busy', ['task']], `a task in ${st} does not hold its stand`);
  for (const st of ['backlog', 'todo', 'review', 'done', 'cancelled']) assert.equal(at(st).state, 'free', `a task in ${st} holds its stand`);
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [{ found: null, merge: true }], sessions: 0, processes: 0, ignored: { files: 0 } }).why, ['merge']);
});

test('the task of a cleanup says each rule of the check, in both languages, and no fetch where there is no origin', () => {
  const st = { path: '/r/.claude/worktrees/X-1', branch: 'claude/X-1', head: 'abcdef0123456789', size: 5 * 1024 ** 2 };
  const big = { path: '/r/.claude/worktrees/X-4', branch: null, head: '0123456789abcdef', size: 1.5 * 1024 ** 3 };
  const gone = { ...st, path: '/r/.claude/worktrees/X-2', branch: 'claude/X-2', missing: true };
  for (const lang of ['en', 'ru']) {
    const w = stands.cleanupWords(lang, { top: '/r', main: 'origin/main', ref: 'refs/remotes/origin/main' }, [st, gone, big], []);
    const say = (re, what) => assert.match(w, re, `${lang}: ${what}`);
    say(lang === 'en' ? /never --force/ : /\u0431\u0435\u0437 --force/, '--force is not forbidden');
    say(lang === 'en' ? /never -D/ : /\u043d\u0435 -D/, '-D is not forbidden');
    say(lang === 'en' ? /right before removing/ : /\u043f\u0440\u044f\u043c\u043e \u043f\u0435\u0440\u0435\u0434 \u0443\u0434\u0430\u043b\u0435\u043d\u0438\u0435\u043c/, 'no check again right before the removal');
    say(lang === 'en' ? /main checkout, the branch main, other projects or the stash/ : /\u041e\u0441\u043d\u043e\u0432\u043d\u043e\u0439 \u0447\u0435\u043a\u0430\u0443\u0442, \u0432\u0435\u0442\u043a\u0443 main, \u0447\u0443\u0436\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u044b \u0438 stash/, 'the main checkout, main and the stash are not kept');
    say(lang === 'en' ? /last commit of each removed branch/ : /\u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0439 \u043a\u043e\u043c\u043c\u0438\u0442 \u043a\u0430\u0436\u0434\u043e\u0439 \u0443\u0434\u0430\u043b\u0451\u043d\u043d\u043e\u0439 \u0432\u0435\u0442\u043a\u0438/, 'the last commit of a removed branch is not asked for');
    say(/status --porcelain --ignored/, 'ignored data is not looked at');
    say(/\.env/, 'the ignored data is not named');
    say(/git merge-tree --write-tree --merge-base=<sha>\^ refs\/remotes\/origin\/main <sha>/, 'a «+» commit is not checked by its changes against the full ref');
    say(/git rev-parse <sha>\^\{tree\} <sha>\^\^\{tree\}/, 'a commit that changes nothing is taken for its changes in main');
    say(/git cherry refs\/remotes\/origin\/main </, 'main is named by its short name, which a local branch «origin/main» takes over');
    say(/git rev-list --merges --parents refs\/remotes\/origin\/main\.\.</, 'the merges of the branch are not looked at');
    say(/git merge-tree --write-tree <[^>]+1> <[^>]+2>/, 'a merge is not merged again from its parents');
    say(/git fetch origin/, 'origin is not fetched');
    say(lang === 'en' ? / 5 MB/ : / 5 \u041c\u0411/, 'a small stand is not in MB of the language');
    say(lang === 'en' ? / 1\.5 GB/ : / 1,5 \u0413\u0411/, 'a big stand is not in GB of the language');
    say(lang === 'en' ? /\u2014 branch claude\/X-1 / : /\u2014 \u0432\u0435\u0442\u043a\u0430 claude\/X-1 /, 'the branch of a stand is not named in the language');
    say(lang === 'en' ? /\u2014 detached HEAD/ : /\u2014 \u043e\u0442\u0434\u0435\u043b\u0451\u043d\u043d\u044b\u0439 HEAD/, 'a stand without a branch is not named in the language');
    say(/master/, 'the check does not keep master out');
    // each rule of «not busy» and of the ignored data said in the task — Claude checks by these words alone
    say(lang === 'en' ? /no project of the board lives in the folder/ : /\u043d\u0435 \u0436\u0438\u0432\u0451\u0442 \u043f\u0440\u043e\u0435\u043a\u0442 \u0434\u043e\u0441\u043a\u0438/, 'a project of the board in the folder is not checked');
    say(/prep\/doing\/ready\/deploy/, 'the working columns of the task are not all named');
    say(/lsof \+D <[^>]+>/, 'the processes in the folder are not looked at');
    say(/lsof \+D <[^>]+>`; [^)]*root/, 'the task does not warn that lsof sees only the processes of its own user');
    say(/git -c core\.quotePath=false -C <[^>]+> status --porcelain --ignored`/, 'the names of ignored files come quoted (Cyrillic)');
    say(/--ignored --untracked-files=all -- </, 'a folder of ignored files («!! .claude/») is not looked into');
    // were codes on a Russian board; a Russian task with English words passed)
    const ask = { path: '/r/.claude/worktrees/X-3', branch: 'claude/X-3', read: true, dirty: 1, commits: [{ found: null }, { found: null, merge: true }], sessions: 0, processes: 0, ignored: { files: 1, paths: [] } };
    const ask2 = { path: '/r/.claude/worktrees/X-5', branch: null, detached: true, locked: 'held', read: true, dirty: null, commits: [{ found: null }], sessions: 0, processes: 0, ignored: { files: 0, paths: [] } };
    assert.deepEqual([...stands.standState(ask).why, ...stands.standState(ask2).why].sort(), ['commits', 'detached', 'dirty', 'ignored', 'locked', 'merge', 'unknown', 'commits'].sort());
    const text = stands.cleanupWords(lang, { top: '/r', main: 'origin/main', ref: 'refs/remotes/origin/main' }, [st], [ask, ask2]).split('\n');
    for (const a of [ask, ask2]) {
      const line = text.find((l) => l.startsWith(`- ${a.path}`));
      const reasons = line.slice(line.indexOf(': ') + 2).split(', ');
      assert.ok(!reasons.some((r) => /^[a-z]+$/.test(r)), `${lang}: the reasons are codes, not words: ${line}`);
      if (lang === 'ru') assert.ok(reasons.every((r) => /[\u0400-\u04ff]/.test(r)), `ru: the reasons are not in Russian: ${line}`);
      else assert.doesNotMatch(line, /[\u0400-\u04ff]/, `en: the reasons are in Russian: ${line}`);
    }
    assert.doesNotMatch(w, /\(\u0441 --force\)|\(with --force\)/, `${lang}: --force is advised`);
    const goneLine = w.split('\n').find((l) => l.startsWith(`- ${gone.path} `));
    assert.match(goneLine, /git worktree remove/, `${lang}: the folder-less stand is not told how to drop its record alone`);
    assert.doesNotMatch(goneLine.replace(/(not|\u043d\u0435) `git worktree prune`/g, ''), /git worktree prune/, `${lang}: the folder-less stand is told to prune the whole repository`);
    const local = stands.cleanupWords(lang, { top: '/r', main: 'main', ref: 'refs/heads/main' }, [st], []);
    assert.doesNotMatch(local, /git fetch origin/, `${lang}: a repository without origin is told to fetch it`);
    assert.match(local, /git cherry refs\/heads\/main /);
  }
});

test('a stand a project of the board lives in is busy, not free', async () => {
  mkdirSync(join(wt('empty'), 'app'));
  const id = db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sth', 'STH', 'Lives in a stand', ?, 1)").run(join(wt('empty'), 'app')).lastInsertRowid;
  try {
    const d = await walked();
    const s = d.stands.find((x) => x.path === wt('empty'));
    assert.equal(s.state, 'busy', 'the folder of a project read as free');
    assert.deepEqual(s.why, ['project']);
  } finally {
    db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(id);
    rmSync(join(wt('empty'), 'app'), { recursive: true, force: true });
  }
});

// a stand with a live process was «free». A stand-in lsof first in PATH answers each way in turn
test('lsof is believed only whole: exit 0 with folders, or exit 1 with some', async () => {
  const fake = join(tmp, 'fakebin');
  mkdirSync(fake, { recursive: true });
  const mode = join(fake, 'mode');
  writeFileSync(join(fake, 'lsof'), `#!/bin/sh\ncase "$(cat '${mode}')" in\n  ok) printf 'p1\\nn${tmp}\\np2\\nn${wt('served')}\\n'; exit 0;;\n  partial1) printf 'p2\\nn${wt('served')}\\n'; exit 1;;\n  partial2) printf 'p1\\nn${tmp}\\n'; exit 2;;\n  killed) printf 'p1\\nn${tmp}\\n'; kill -KILL $$;;\n  empty) exit 0;;\nesac\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${fake}:${path}`;
  const look = async (m) => {
    writeFileSync(mode, m);
    stands.forgetStands();
    const d = await walked();
    return Object.fromEntries(d.stands.map((x) => [x.path.split('/').pop(), x]));
  };
  try {
    for (const m of ['ok', 'partial1']) {
      const by = await look(m);
      assert.deepEqual([by.served.state, by.served.why], ['busy', ['process']], `${m}: the process in the folder was not seen`);
      assert.equal(by['STA-1'].state, 'free', `${m}: a whole answer of lsof was not believed`);
    }
    for (const m of ['partial2', 'killed', 'empty']) { // killed: by a signal halfway (or by the timeout) — the list is partial
      const by = await look(m);
      assert.ok(!Object.values(by).some((x) => x.state === 'free'), `${m}: a failed lsof let a stand read as free — ${Object.values(by).filter((x) => x.state === 'free').map((x) => x.path).join(', ')}`);
      assert.ok(by['STA-1'].why.includes('unknown'), `${m}: the stand does not say lsof could not tell`);
    }
  } finally {
    process.env.PATH = path;
    stands.forgetStands();
  }
});

// a stand with a process in it as much as a free one. The walk looks for lsof after PATH too (bin(name, also)). A board
// STARTED with such a PATH, in a process of its own: stands.js keeps the environment it was loaded with, so a PATH changed
// here would not reach its calls, and the test of bin() alone stayed green with the walk calling bin('lsof') again
test('a board started with a PATH without the folder of lsof still sees the process in a stand', { skip: !existsSync('/usr/sbin/lsof') && 'lsof is not in /usr/sbin here' }, async () => {
  const path = process.env.PATH.split(':').filter((d) => d && !existsSync(join(d, 'lsof'))).join(':');
  assert.equal(onPath('lsof', { PATH: path }), null, 'the PATH of the test still has lsof');
  const script = `const s = await import(${JSON.stringify(new URL('../src/stands.js', import.meta.url).href)});
    s.standsView(); await s.standsSettled();
    const by = Object.fromEntries(s.standsView().stands.map((x) => [x.path.split('/').pop(), [x.state, x.why]]));
    process.stdout.write(JSON.stringify(by), () => process.exit(0));`;
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: path }, timeout: 120_000 }, (err, o, e) => (err ? reject(new Error(`${err.message}\n${e}`)) : resolve(o)));
  });
  const by = JSON.parse(out);
  assert.deepEqual(by.served, ['busy', ['process']], 'lsof outside PATH was not found: the process in the folder went unseen');
  assert.equal(by['STA-1'][0], 'free', 'lsof outside PATH was not found: a free stand read «unknown»');
});

// on another branch), a project of the board in a repository of its own nested inside a stand (dist/sub, node_modules/x:
// another git-common-dir, and `git worktree remove` takes it along), and a project reached through a link, either way round
test('main, a nested project and a project behind a link hold their stand', async () => {
  const k = join(tmp, 'kept');
  const far = join(tmp, 'kept-wt');
  mkdirSync(k); mkdirSync(far);
  git(k, 'init', '-q', '-b', 'main');
  writeFileSync(join(k, '.gitignore'), 'dist/\nnode_modules/\n');
  git(k, 'add', '.gitignore'); git(k, 'commit', '-q', '-m', 'start');
  git(k, 'checkout', '-q', '-b', 'dev');
  const add = (dir, ...branch) => { git(k, 'worktree', 'add', '-q', dir, ...branch); return dir; };
  add(join(far, 'wt-main'), 'main');
  add(join(far, 'wt-free'), '-b', 'claude/free');
  const nested = (dir, sub) => {
    mkdirSync(join(dir, sub), { recursive: true });
    git(join(dir, sub), 'init', '-q', '-b', 'main');
    commit(join(dir, sub), 'n.txt', 'n\n', 'nested');
    return join(dir, sub);
  };
  const inDist = nested(add(join(far, 'wt-dist'), '-b', 'claude/dist'), 'dist/sub');
  const inModules = nested(add(join(far, 'wt-nm'), '-b', 'claude/nm'), 'node_modules/x');
  // the folder of a stand moved and a link left in its place: git lists it by the old path, the project is named by the real one
  add(join(tmp, 'kept-hold', 'wt-moved'), '-b', 'claude/moved');
  execFileSync(fullPath('mv'), [join(tmp, 'kept-hold'), join(tmp, 'kept-hold-real')]);
  symlinkSync(join(tmp, 'kept-hold-real'), join(tmp, 'kept-hold'));
  mkdirSync(join(tmp, 'kept-hold-real', 'wt-moved', 'app'));
  // a project named by a link into a stand
  mkdirSync(join(add(join(far, 'wt-alias'), '-b', 'claude/alias'), 'app'));
  symlinkSync(join(far, 'wt-alias'), join(tmp, 'alias'));
  const ins = db.prepare('INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES (?, ?, ?, ?, 1)');
  const ids = [['kpt', 'KPT', k], ['kds', 'KDS', inDist], ['knm', 'KNM', inModules], ['kmv', 'KMV', join(tmp, 'kept-hold-real', 'wt-moved', 'app')], ['kal', 'KAL', join(tmp, 'alias', 'app')]]
    .map(([slug, prefix, path]) => ins.run(slug, prefix, slug, path).lastInsertRowid);
  try {
    const d = await walked();
    const by = Object.fromEntries(d.stands.filter((x) => x.top === k).map((x) => [x.path.split('/').pop(), x]));
    assert.deepEqual(Object.keys(by).sort(), ['wt-alias', 'wt-dist', 'wt-free', 'wt-main', 'wt-moved', 'wt-nm']);
    assert.equal(d.repos.find((r) => r.top === k).ref, 'refs/heads/main', 'a repository without origin is not measured against its own main');
    assert.deepEqual([by['wt-free'].state, by['wt-free'].why], ['free', []], 'a clean stand of the second repository is not free — the checks below prove nothing');
    assert.deepEqual([by['wt-main'].state, by['wt-main'].why], ['busy', ['main']], 'a worktree on main read as a stand to remove — the cleanup would delete main');
    assert.deepEqual([by['wt-dist'].state, by['wt-dist'].why], ['busy', ['project']], 'a project in a repository nested in dist/ of a stand read as free');
    assert.deepEqual([by['wt-nm'].state, by['wt-nm'].why], ['busy', ['project']], 'a project in a repository nested in node_modules/ of a stand read as free');
    assert.ok(by['wt-moved'].path !== realpathSync(by['wt-moved'].path), 'the moved stand is listed by its real path — the case is not made');
    assert.deepEqual([by['wt-moved'].state, by['wt-moved'].why], ['busy', ['project']], 'a project in a stand git lists through a link read as free');
    assert.deepEqual([by['wt-alias'].state, by['wt-alias'].why], ['busy', ['project']], 'a project named through a link into a stand read as free');
  } finally {
    for (const id of ids) db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(id);
  }
});

test('CK-983: a stand is named by the project of its key wherever that lives, else by the repository; the cleanup goes to a project of the repository', async () => {
  // a repository with two projects in subfolders and none at its top — as the owner's shared one
  const shared = join(tmp, 'shared-root');
  mkdirSync(join(shared, 'site'), { recursive: true });
  mkdirSync(join(shared, 'bot'), { recursive: true });
  git(shared, 'init', '-q', '-b', 'main');
  commit(shared, 'site/s.txt', 's\n', 'start');
  const add = (name, branch) => { const p = join(shared, '.claude', 'worktrees', name); git(shared, 'worktree', 'add', '-q', p, '-b', branch); return p; };
  add('loose-thing', 'claude/loose-thing'); // no key
  add('STA-1', 'claude/STA-1'); // the key of a project of ANOTHER repository (sta lives in `repo`), its task in review
  add('SHB-1', 'claude/SHB-1'); // the key of the second project of this one
  const ins = db.prepare('INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES (?, ?, ?, ?, 2)');
  const site = ins.run('sha', 'SHA', 'Site first', join(shared, 'site')).lastInsertRowid;
  const bot = ins.run('shb', 'SHB', 'The bot', join(shared, 'bot')).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Bot thing', 'review')").run(bot);
  try {
    const d = await walked();
    const by = Object.fromEntries(d.stands.filter((x) => x.top === shared).map((x) => [x.path.split('/').pop(), x]));
    assert.deepEqual(Object.keys(by).sort(), ['SHB-1', 'STA-1', 'loose-thing']);
    assert.equal(by['loose-thing'].project, null, 'a stand without a key was given the first project of the repository');
    assert.equal(by['loose-thing'].repo_name, 'shared-root');
    assert.deepEqual(by['STA-1'].project, { slug: 'sta', name: 'Stands' }, 'the project of a key from another repository was dropped');
    assert.deepEqual(by['SHB-1'].project, { slug: 'shb', name: 'The bot' });
    for (const s of Object.values(by)) assert.equal(s.state, 'free', `${s.path}: ${s.why}`);
    // the leaf of the page names the repository where there is no project
    const { cleanupProject } = stands;
    const repoOf = d.repos.find((r) => r.top === shared);
    assert.equal(cleanupProject(repoOf, [by['loose-thing'], by['STA-1']], Object.values(by)), 'shb',
      'with no chosen stand named by a project of this repository, the one naming most of its stands takes the cleanup');
    assert.equal(cleanupProject(repoOf, [by['loose-thing']], [by['loose-thing']]), 'sha', 'nothing named at all — the first one of the repository');
    const r = await app.inject({ method: 'POST', url: '/api/health/stands/task', headers: { host }, payload: { paths: [by['loose-thing'].path, by['STA-1'].path] } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().tasks.map((t) => [t.project, t.n]), [['shb', 2]], 'the cleanup went to a project not of this repository or to the first one');
  } finally {
    db.prepare('UPDATE projects SET archived = 1 WHERE id IN (?, ?)').run(site, bot);
  }
});
