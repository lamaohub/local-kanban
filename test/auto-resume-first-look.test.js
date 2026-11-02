// A restarted board knows no screens until its first look is over: a kept record must not type into what it cannot see.
// A file of its own: the first look of a process happens once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, db, auto, resume, live;
const QUESTION = 'aaaaaaaa-0001-4000-8000-aaaaaaaaaaaa';
const LIMIT = 'aaaaaaaa-0002-4000-8000-aaaaaaaaaaaa';
const FREE = 'aaaaaaaa-0003-4000-8000-aaaaaaaaaaaa';
const NOW = Date.now();
// a moment an hour on, in the words of a limit line
const inAnHour = (() => { const d = new Date(NOW + 3600_000); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; })();
const told = [];
const tasks = new Map();

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-first-look-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.KB_TMUX_SOCKET = `kb-test-first-look-${process.pid}`;
  const d = await import('../src/db.js');
  db = d.db;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('fl', 'FL', 'First look', 4)").run();
  const project = db.prepare("SELECT id FROM projects WHERE slug = 'fl'").get().id;
  [QUESTION, LIMIT, FREE].forEach((sid, i) => {
    const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'doing')").run(project, i + 1, sid).lastInsertRowid;
    db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-31 10:00:00', '2026-10-31 10:00:01')").run(id, sid);
    tasks.set(sid, { key: `FL-${i + 1}`, status: 'doing' });
  });
  // what the board before the restart kept
  d.kvSet('automations.resume.stopped', JSON.stringify({
    [QUESTION]: { key: 'FL-1', why: 'resume', at: NOW - 60_000 },
    [LIMIT]: { key: 'FL-2', why: 'limit', at: NOW - 2 * 3600_000 },
    [FREE]: { key: 'FL-3', why: 'resume', at: NOW - 60_000 },
  }));
  d.kvSet('automations.on', '1');
  d.kvSet('automations.resume', '1');
  auto = await import('../src/automations.js');
  resume = await import('../src/auto-resume.js');
  live = await import('../src/claude-live.js');
  resume.setResumeDeps({
    // the real one reads the state out of the registry and the screens: `limit` only for what the last look saw
    runs: async () => ({ runs: [QUESTION, LIMIT, FREE].map((sid) => ({ session: sid, board: true, claude: live.currentLimited().has(sid) ? 'limit' : 'idle', resets: live.currentLimited().get(sid)?.resets, tasks: [tasks.get(sid)] })) }),
    turn: async () => ({ open: true, items: [] }),
    fieldEmpty: async () => true,
    say: async (t, sid) => { told.push(sid); return { ok: true }; },
  });
});

after(() => {
  delete process.env.KB_LAUNCH_DRYRUN;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('nothing is typed before the first look is over, and what it saw holds the words', async () => {
  await auto.tickAutomations({}, NOW);
  assert.deepEqual(told, [], 'words typed into screens the board has not read: an Enter into a question, words over a limit');
  await live.refreshLive(undefined, async () => ({ failed: true }));
  await auto.tickAutomations({}, NOW + 1000);
  assert.deepEqual(told, [], 'a look tmux did not answer read as a look at the screens');
  await live.refreshLive(undefined, async () => ({ live: [QUESTION, LIMIT], questions: [QUESTION], limited: [{ sid: LIMIT, resets: inAnHour }] }));
  await auto.tickAutomations({}, NOW + 2000);
  assert.deepEqual(told, [FREE], 'what the first look saw did not hold the words, or the look never went');
});
