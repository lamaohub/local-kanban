// a restart — before the board had read its screens, when «no question» means «not read yet»: a check over a question.
// of a process happens once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, auto, live, db;
const NOW = Date.now();
const calls = [];
// the board's routes as the rule calls them; a refusal is enough — the call is what is looked at
const app = { inject: async (o) => { calls.push(`${o.method} ${o.url}`); return { statusCode: 500, body: '{}', json: () => ({ error: 'stand-in' }) }; } };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-rule-look-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-test-rule-look-${process.pid}`;
  const d = await import('../src/db.js');
  db = d.db;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('rl', 'RL', 'Rule look', 2, ?)").run(tmp);
  const project = db.prepare("SELECT id FROM projects WHERE slug = 'rl'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'handed in', 'review')").run(project);
  // armed, Claude's work seen, its pause long over
  db.prepare(`INSERT INTO automations (project_id, kind, delay_s, state, seen_work, ready_at, words, created_at)
    VALUES (?, 'finished-check', 60, 'armed', 1, ?, ?, ?)`).run(project, NOW - 3600_000, JSON.stringify({ run: 'go', title: 'Check', doTask: 'Do' }), NOW - 2 * 3600_000);
  d.kvSet('automations.on', '1');
  auto = await import('../src/automations.js');
  live = await import('../src/claude-live.js');
});
after(() => {
  delete process.env.KB_LAUNCH_DRYRUN;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('a rule whose pause ran out starts nothing before the first look at the screens', async () => {
  await auto.tickAutomations(app, NOW);
  assert.deepEqual(calls, [], 'a check started over screens the board had not read');
  await live.refreshLive(undefined, async () => ({ failed: true }));
  await auto.tickAutomations(app, NOW + 5000);
  assert.deepEqual(calls, [], 'a look tmux did not answer read as a look at the screens');
  await live.refreshLive(undefined, async () => ({ live: [], questions: [], background: [], over: [], limited: [] }));
  await auto.tickAutomations(app, NOW + 10_000);
  assert.ok(calls.length > 0, 'after the first look the rule did not start — the guard holds it for good');
});
