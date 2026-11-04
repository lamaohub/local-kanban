// repository with an origin, a worktree in each state the section tells apart, and the real routes over a database of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';

let tmp, repo, app, db, stands, host, sleeper;
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
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
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
  // the folder deleted by hand, its branch with work not in main (a prunable worktree)
  commit(stand('gone', 'claude/gone'), 'g.txt', 'gone\n', 'Work left on a branch whose folder went');
  rmSync(wt('gone'), { recursive: true, force: true });
  // a title that says nothing is in any log: «WIP» in main proves nothing about this one
  commit(stand('wip', 'claude/wip'), 'w.txt', 'mine\n', 'WIP');

  // main moves on first: a cherry-pick onto the same parent in the same second would make the very same commit
  commit(repo, 'r2.txt', 'theirs\n', 'Same title in main');
  git(repo, 'cherry-pick', picked);
  commit(repo, 'b.txt', 'batch\n', 'The batch, squashed (o/r#77, o/r#79)');
  commit(repo, 'w2.txt', 'theirs\n', 'WIP');
  git(repo, 'push', '-q', 'origin', 'main');
  sleeper = spawn('/bin/sleep', ['60'], { cwd: proc, stdio: 'ignore' });

  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_CLAUDE_DIR = join(tmp, 'claude');
  mkdirSync(join(tmp, 'claude', 'sessions'), { recursive: true });
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
  const by = Object.fromEntries(d.stands.map((s) => [s.path.split('/').pop(), s]));
  assert.deepEqual(Object.keys(by).sort(), ['STA-1', 'dirty', 'empty', 'gone', 'issued', 'lost', 'retitled-9f3e1a', 'served', 'sta-2-busy', 'wip'], 'the main checkout is no stand');
  assert.equal(by.gone.state, 'unsent', 'a stand whose folder went read as free, its branch never compared with main');
  assert.deepEqual(by.gone.why, ['commits']);
  assert.equal(by.wip.state, 'unsent', '«WIP» in main read as this very work');
  assert.equal(by['STA-1'].state, 'free');
  assert.equal(by['STA-1'].commits[0].found, 'patch');
  assert.equal(by['STA-1'].key, 'STA-1');
  assert.equal(by['STA-1'].task.status, 'review');
  assert.equal(by['retitled-9f3e1a'].state, 'free');
  assert.equal(by['retitled-9f3e1a'].commits[0].found, 'title');
  assert.equal(by['retitled-9f3e1a'].key, null, 'a hash tail read as a key');
  assert.equal(by.issued.state, 'free');
  assert.equal(by.issued.commits[0].found, 'issue');
  assert.equal(by.empty.state, 'free');
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
  assert.equal(t.n, 4);
  const task = db.prepare("SELECT t.status, t.description FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(t.key);
  assert.equal(task.status, 'todo');
  for (const name of ['STA-1', 'retitled-9f3e1a', 'issued', 'empty']) assert.ok(task.description.includes(`${wt(name)} —`), `${name} is not in the task`);
  for (const name of ['served', 'sta-2-busy']) assert.ok(!task.description.includes(wt(name)), `a busy stand ${name} got into the task`);
  const asks = task.description.slice(task.description.lastIndexOf('\n\n', task.description.indexOf(wt('lost'))));
  assert.ok(asks.includes(wt('lost')) && asks.includes(wt('dirty')), 'the stands with work not in main are not named for the owner');
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
  const dirty = (await get(`/api/health/stands/diff?path=${encodeURIComponent(wt('dirty'))}`)).json();
  assert.match(dirty.text, /notes\.txt/);
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
  const msgs = new Map([['aaaaaaa', { title: 'The same work by its title', body: '' }], ['bbbbbbb', { title: 'U (o/r#1, o/r#3)', body: '' }], ['ccccccc', { title: 'V (o/r#2)', body: '' }]]);
  assert.deepEqual(stands.matchCommits('- 1111111\n+ aaaaaaa\n+ bbbbbbb\n+ ccccccc\n', msgs, main).map((c) => c.found), ['patch', 'title', null, 'issue'],
    'a commit with one issue of two in main read as handed in');
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], locked: 'x', sessions: 0, processes: 0 }).why, ['locked']);
  assert.deepEqual(stands.standState({ read: true, dirty: 0, commits: [], sessions: 0, processes: null }).why, ['unknown'], 'lsof that did not answer read as «no process»');
  assert.equal(stands.telling('WIP'), false);
  assert.equal(stands.telling('Fix tests'), false);
  assert.equal(stands.telling('Same title in main'), true);
  assert.equal(stands.standState({ read: false }).state, 'reading');
});
