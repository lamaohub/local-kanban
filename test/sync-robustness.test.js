import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, db, github, drain, enqueue;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'someone';
  process.env.KB_GH_REPO = 'someone/board';
  ({ db, enqueue } = await import('../src/db.js'));
  github = await import('../src/sync/github.js');
  ({ drain } = await import('../src/sync/worker.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = true; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('a transient network answer is not marked as permanent', () => {
  assert.equal(github.isPermanent(`invalid character '<' looking for beginning of value`), false,
    'a captive portal answer still goes straight to failed without a single retry');
  assert.equal(github.isPermanent('dial tcp: lookup api.github.com: no such host'), false);
  assert.equal(github.isPermanent('Post "https://api.github.com/graphql": unexpected EOF'), false);
});

test('an unambiguous GitHub refusal is still permanent', () => {
  assert.equal(github.isPermanent('GraphQL: Could not resolve to a Repository with the name someone/board.'), true);
  assert.equal(github.isPermanent('HTTP 422: Validation Failed'), true);
  assert.equal(github.isPermanent(`could not add label: 'security' not found`), true);
});

test('an answer without an issue link is a failure, not a NULL issue number', () => {
  assert.throws(() => github.parseIssueNumber('Warning: something went sideways'), /without an issue link/,
    'a garbage answer is still reported as a created issue, and CK-321 then stamps new ones');
  assert.throws(() => github.parseIssueNumber(''), /without an issue link/);
  assert.equal(github.parseIssueNumber('https://github.com/someone/board/issues/42'), 42);
});

test('setItemStatus without a card on the board is not a silent success', async () => {
  await assert.rejects(
    () => github.setItemStatus({ gh_status_options: '{"todo":"opt"}' }, null, 'todo'),
    /waiting for create_issue/,
    'the op counted as done and moved the "last successful sync" mark',
  );
});

test('a restarted create_issue adopts the issue it already made', async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'t','todo')").run(pid);
  const tid = db.prepare('SELECT id FROM tasks').get().id;
  enqueue('create_issue', tid, { task_id: tid, key: 'DM-1', title: 't', description: '', labels: [], status: 'todo' });
  const row = db.prepare("SELECT * FROM sync_queue WHERE op='create_issue'").get();
  assert.notEqual(row, undefined);

  db.prepare("UPDATE sync_queue SET started_at = datetime('now') WHERE id = ?").run(row.id);

  let created = 0;
  const searched = [];
  const stub = {
    ensureProject: async (p) => p,
    findIssueByKey: async (key) => { searched.push(key); return { number: 41, url: 'https://github.com/someone/board/issues/41' }; },
    createIssueOnly: async () => { created++; return { number: 99, url: 'https://x/issues/99' }; },
    addToProject: async () => 'item-1',
    setItemStatus: async () => {},
  };
  const { processOp } = await import('../src/sync/worker.js');
  await processOp(db.prepare('SELECT * FROM sync_queue WHERE id = ?').get(row.id), stub);

  assert.deepEqual(searched, ['DM-1'], 'a retry after a restart did not look for the issue it already created');
  assert.equal(created, 0, 'a second issue was created for the same task');
  assert.equal(db.prepare('SELECT gh_issue_number FROM tasks WHERE id = ?').get(tid).gh_issue_number, 41);
});
