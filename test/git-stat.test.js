// repository that is not the mirror of issues that is its own pull request («Merge pull request #12») — and, for a task
// without an issue, by the newest commit of the project, whoever made it. Now the commit is the task's by the rule of the
// mark «on main» (src/shipped.js): the key its subject claims, the mirror's `owner/repo#N`, a bare `#N` only at home.
// Real git; KB_DATA_DIR isolates the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin } from '../src/bin-path.js';
// start of tmux in the tests beside this file for 10 s and more
const GIT = bin('git');

let tmp, repo, app, db, statCommit, STAT_FORMAT, wordsOf;
const git = (...a) => execFileSync(GIT, ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
let n = 0;
const commit = (subject, body = '') => {
  writeFileSync(join(repo, 'f.txt'), String(++n));
  git('add', 'f.txt');
  git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  return git('rev-parse', '--short', 'HEAD').trim();
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  repo = mkdtempSync(join(tmpdir(), 'kb-repo-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'octocat';
  process.env.KB_GH_REPO = 'hello-world';
  execFileSync(GIT, ['init', '-q', '-b', 'main', repo]);
  git('remote', 'add', 'origin', 'https://github.com/someone/other-project.git'); // not the mirror
  ({ db } = await import('../src/db.js'));
  ({ statCommit, STAT_FORMAT, wordsOf } = await import('../src/shipped.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('gs', 'GS', 'Git stat', ?, 10)").run(repo);
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'gs'").get().id;
  for (const no of [1, 2, 3, 4]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'doing')").run(pid, no, `Task ${no}`);
  db.prepare("UPDATE tasks SET gh_issue_number = 12 WHERE task_no = 1 AND project_id = ?").run(pid);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => {
  await app?.close();
  delete process.env.KB_GH_OWNER; delete process.env.KB_GH_REPO;
  for (const d of [tmp, repo]) if (d) rmSync(d, { recursive: true, force: true });
});

const log = () => git('log', '-n', '50', `--format=${STAT_FORMAT}`);
const statOf = async (key) => {
  for (let i = 0; i < 50; i += 1) {
    const row = db.prepare(`SELECT c.body FROM task_comments c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
      WHERE c.author = 'git' AND p.prefix || '-' || t.task_no = ?`).get(key);
    if (row) return row.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};

test('the rule: a bare #N of a foreign repository is its pull request, the key or owner/repo#N is the task', () => {
  const foreign = commit('Merge pull request #12 from someone/fix');
  const known = new Set(['GS']);
  assert.equal(statCommit(log(), wordsOf('GS-1', 12, 'octocat/hello-world', false), { issue: 12, known }), null, 'a foreign pull request read as the task\'s commit');
  assert.ok(statCommit(log(), wordsOf('GS-1', 12, 'octocat/hello-world', true), { issue: 12, known }).startsWith(foreign), 'at home a bare #N is the issue');
  const own = commit('Fix the thing (octocat/hello-world#12)');
  assert.ok(statCommit(log(), wordsOf('GS-1', 12, 'octocat/hello-world', false), { issue: 12, known }).startsWith(own));
  const keyed = commit('GS-1 a follow-up to GS-2');
  assert.ok(statCommit(log(), wordsOf('GS-1', 12, 'octocat/hello-world', false), { issue: 12, known }).startsWith(keyed), 'the newest commit of the task first');
  assert.equal(statCommit(log(), wordsOf('GS-2', null, '', false), { known, since: 0 }), null, 'a key named only further on is a mention, and HEAD claims another task');
});

test('without an issue: the newest commit since the work began, unless it claims another task or is a merge', () => {
  const known = new Set(['GS']);
  const words = wordsOf('GS-3', null, '', false);
  const now = Math.floor(Date.now() / 1000);
  const plain = commit('Tidy up the readme');
  assert.ok(statCommit(log(), words, { known, since: now - 60 }).startsWith(plain), 'a commit that names nothing is the fallback, as before');
  assert.equal(statCommit(log(), words, { known, since: now + 3600 }), null, 'a commit older than the work is not the task\'s');
  commit('GS-2 another task');
  assert.equal(statCommit(log(), words, { known, since: now - 60 }), null, 'the newest commit of another task hung on this one');
  commit('Merge branch \'side\'');
  assert.equal(statCommit(log(), words, { known, since: now - 60 }), null, 'a merge is nobody\'s work');
  const mine = commit('GS-3 the work');
  assert.ok(statCommit(log(), words, { known, since: now - 60 }).startsWith(mine));
});

test('the card: a move to review hangs the task\'s commit, not a foreign pull request or another task\'s HEAD', async () => {
  // HEAD claims GS-3; GS-1 has its own commit further down, and a foreign #12 at the very top
  const own = commit('GS-1 the real work');
  commit('GS-3 more work');
  commit('Merge pull request #12 from someone/other');
  const move = (key) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload: { status: 'review' } });
  assert.equal((await move('GS-1')).statusCode, 200);
  const body = await statOf('GS-1');
  assert.ok(body?.startsWith(`${own} GS-1 the real work`), `the card of GS-1 got: ${body}`);
  // GS-4 has no issue and no commit of its own, its work began an hour ago: HEAD is a merge, so nothing
  db.prepare("UPDATE tasks SET work_started_at = datetime('now', '-1 hour') WHERE task_no = 4").run();
  assert.equal((await move('GS-4')).statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await statOf('GS-4'), null, 'a task with no commit of its own got another one');
});
