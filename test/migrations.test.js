import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function migrateDir(dir, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js';"], {
    cwd: ROOT,
    env: { ...process.env, KB_DATA_DIR: dir, KB_GH_OWNER: '', KB_GH_REPO: '', ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `starting db.js failed:\n${res.stderr}`);
}

function shape(dir) {
  const db = new Database(join(dir, 'kanban.db'));
  const out = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  for (const { name } of tables) {
    out[name] = db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name}')`)
      .all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
      .sort();
  }
  out.__indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
  ).all().map((i) => i.name);
  db.close();
  return out;
}

function checkHealthy(db) {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('user_version', { simple: true }) >= 1, true, 'user_version is set');
}

function seedV1(dir) {
  const old = new Database(join(dir, 'kanban.db'));
  old.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      path TEXT, server_path TEXT, deploy_skill TEXT, server TEXT, pm2_services TEXT,
      domain TEXT, category TEXT, gh_project_number INTEGER, gh_project_id TEXT,
      gh_status_field_id TEXT, gh_status_options TEXT, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','deploy','review','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT,
      position REAL NOT NULL DEFAULT 0, gh_issue_number INTEGER, gh_issue_url TEXT, gh_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at TEXT
    );
    CREATE TABLE task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT 'me', body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO projects (slug, name) VALUES ('old-proj', 'Old project');
    INSERT INTO tasks (project_id, title, status) VALUES (1, 'first', 'todo');
    INSERT INTO tasks (project_id, title, status) VALUES (1, 'in progress', 'doing');
    INSERT INTO tasks (project_id, title, status, done_at) VALUES (1, 'finished', 'done', datetime('now'));
    INSERT INTO task_comments (task_id, body) VALUES (2, 'an important comment');
  `);
  old.close();
}

test('v1 fixture (before backlog/labels/task_no): rows and statuses survive', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-v1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  seedV1(dir);
  migrateDir(dir);

  const db = new Database(join(dir, 'kanban.db'));
  checkHealthy(db);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.equal(tasks.length, 3, 'every task survived');
  assert.deepEqual(tasks.map((x) => x.status), ['todo', 'doing', 'done'], 'statuses are preserved');
  assert.deepEqual(tasks.map((x) => x.task_no), [1, 2, 3], 'task_no was backfilled');
  assert.equal(tasks[0].labels, '[]', 'the new labels column has its default');
  const tSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get().sql;
  assert.ok(tSql.includes("'prep'") && tSql.includes("'backlog'"), 'the CHECK now covers every status');
  assert.equal(db.prepare('SELECT body FROM task_comments').get().body, 'an important comment', 'comments survived');
  assert.ok(db.prepare('SELECT prefix FROM projects').get().prefix, 'the project prefix was backfilled');
  assert.ok(db.prepare("SELECT 1 FROM task_events WHERE task_id=3 AND status='done'").get(), 'the done event was seeded from done_at');
  const backups = readdirSync(join(dir, 'backups', 'pre-migrate')).filter((f) => f.endsWith('.db'));
  assert.equal(backups.length, 1, 'the pre-migrate backup was taken before the migration');
  db.close();
});

test('pre-prep fixture: recreating tasks preserves labels and work time', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const old = new Database(join(dir, 'kanban.db'));
  old.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, prefix TEXT, name TEXT NOT NULL,
      path TEXT, server_path TEXT, deploy_skill TEXT, server TEXT, pm2_services TEXT, domain TEXT,
      category TEXT, description TEXT, gh_project_number INTEGER, gh_project_id TEXT,
      gh_status_field_id TEXT, gh_status_options TEXT, next_task_no INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id), task_no INTEGER,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog','todo','doing','deploy','review','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]',
      blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, position REAL NOT NULL DEFAULT 0,
      work_seconds INTEGER NOT NULL DEFAULT 0, work_started_at TEXT,
      gh_issue_number INTEGER, gh_issue_url TEXT, gh_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at TEXT
    );
    INSERT INTO projects (slug, prefix, name) VALUES ('proj', 'PR', 'Project');
    INSERT INTO tasks (project_id, task_no, title, status, labels, work_seconds)
      VALUES (1, 1, 'with labels', 'backlog', '["bug","ui"]', 3600);
  `);
  old.close();

  migrateDir(dir);

  const db = new Database(join(dir, 'kanban.db'));
  checkHealthy(db);
  const task = db.prepare('SELECT * FROM tasks').get();
  assert.equal(task.labels, '["bug","ui"]', 'labels survived the table rebuild');
  assert.equal(task.work_seconds, 3600, 'the accumulated work time survived');
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get().sql.includes("'prep'"));
  db.close();
});

test('fresh install: user_version is set and no pre-migrate backup is written', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-fresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  migrateDir(dir);

  const db = new Database(join(dir, 'kanban.db'));
  checkHealthy(db);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='tasks'").get(), 'the schema is created');
  assert.equal(existsSync(join(dir, 'backups', 'pre-migrate')), false, 'an empty database needs no backup');
  db.close();
});

test('restarting on an already migrated database is idempotent, no second backup', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-idem-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  migrateDir(dir);
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  checkHealthy(db);
  assert.equal(existsSync(join(dir, 'backups', 'pre-migrate')), false, 'no migrations ran — no backups');
  db.close();
});

test('drift detector: a fresh install\'s schema matches the migrated one', (t) => {
  const fresh = mkdtempSync(join(tmpdir(), 'kb-drift-fresh-'));
  const migrated = mkdtempSync(join(tmpdir(), 'kb-drift-old-'));
  t.after(() => {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(migrated, { recursive: true, force: true });
  });

  migrateDir(fresh);
  seedV1(migrated);
  migrateDir(migrated);

  assert.deepEqual(
    shape(migrated),
    shape(fresh),
    'schema.sql and MIGRATIONS have diverged: a column or index was added to schema.sql — add a MIGRATIONS step',
  );
});

test('pre-migrate rotation keeps the five newest — the one just taken always among them', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-rot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  const from = db.pragma('user_version', { simple: true }) - 1;
  db.pragma(`user_version = ${from}`);
  db.close();
  const pre = join(dir, 'backups', 'pre-migrate');
  mkdirSync(pre, { recursive: true });
  const older = [1, 2, 3, 4, 5].map((n) => `kanban-v${from + 1}-2026-01-0${n}-00-00-00.db`);
  for (const f of older) writeFileSync(join(pre, f), 'x');
  writeFileSync(join(pre, 'notes.db'), 'not a snapshot');

  migrateDir(dir);
  const left = readdirSync(pre).filter((f) => f.startsWith('kanban-v'));
  assert.ok(left.some((f) => f.startsWith(`kanban-v${from}-`)), `the snapshot just taken was rotated away: ${left.join(', ')}`);
  assert.equal(left.length, 5, `expected the five newest, got ${left.length}`);
  assert.ok(!left.includes(older[0]), 'the oldest snapshot should be the one to go');
  assert.ok(existsSync(join(pre, 'notes.db')), 'the rotation removed a file that is not a snapshot');
});

test('the pre-migrate snapshot just taken survives even when the clock went back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-clock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  const from = db.pragma('user_version', { simple: true }) - 1;
  db.pragma(`user_version = ${from}`);
  db.close();
  const pre = join(dir, 'backups', 'pre-migrate');
  mkdirSync(pre, { recursive: true });
  for (const n of [1, 2, 3, 4, 5]) writeFileSync(join(pre, `kanban-v${from}-2099-01-0${n}-00-00-00.db`), 'x');
  migrateDir(dir);
  const left = readdirSync(pre).filter((f) => f.startsWith('kanban-v') && !f.includes('-2099-'));
  assert.equal(left.length, 1, `the snapshot just taken was rotated away (left: ${readdirSync(pre).join(', ')})`);
});

test('pre-migrate rotation orders by time, not by name: version 10 is newer than version 9', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.KB_DATA_DIR = dir;
  const { preMigrateToDrop } = await import('../src/db.js');
  const names = ['kanban-v5-2026-08-01-10-00-00.db', 'kanban-v6-2026-08-20-10-00-00.db', 'kanban-v7-2026-09-10-10-00-00.db',
    'kanban-v8-2026-09-30-10-00-00.db', 'kanban-v9-2026-10-20-10-00-00.db', 'kanban-v10-2026-11-15-10-00-00.db', 'stray.db'];
  assert.deepEqual(preMigrateToDrop(names), ['kanban-v5-2026-08-01-10-00-00.db']);
});

const stepBack = (dir) => {
  const db = new Database(join(dir, 'kanban.db'));
  const from = db.pragma('user_version', { simple: true }) - 1;
  db.pragma(`user_version = ${from}`); // one step back: the last migration step is idempotent
  db.close();
  return from;
};
const zoneOffset = (TZ) => {
  const saved = process.env.TZ;
  process.env.TZ = TZ;
  try {
    const off = -new Date().getTimezoneOffset();
    return `${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${String(Math.abs(off) % 60).padStart(2, '0')}`;
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
};
const utcName = (from, ms) => `kanban-v${from}-${new Date(ms).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.db`; // how names were made before

test('the snapshot before a migration is named by the local clock and its offset, in any time zone', async (t) => {
  const { stampTime } = await import('../src/stamp.js');
  for (const TZ of ['Asia/Bangkok', 'America/Los_Angeles']) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-mig-zone-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    migrateDir(dir);
    const from = stepBack(dir);
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    migrateDir(dir, { TZ });
    const t1 = Date.now();
    const [name, ...more] = readdirSync(join(dir, 'backups', 'pre-migrate')).filter((f) => f.endsWith('.db'));
    assert.equal(more.length, 0);
    const m = new RegExp(String.raw`^kanban-v${from}-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}([+-]\d{4}))\.db$`).exec(name);
    assert.ok(m, `${TZ}: the name is not the local time with its offset: ${name}`);
    assert.equal(m[2], zoneOffset(TZ), `${TZ}: the offset in the name is not the zone's: ${name}`);
    const when = stampTime(m[1]);
    assert.ok(when >= t0 && when <= t1, `${TZ}: the name does not say when the snapshot was taken (UTC digits?): ${name}`);
  }
});

test('pre-migrate rotation orders UTC names and local ones by the moment they stand for', async (t) => {
  const own = mkdtempSync(join(tmpdir(), 'kb-mig-mixorder-'));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  process.env.KB_DATA_DIR = own; // db.js opens a database on import: a folder of its own, unless a test above loaded it
  const { preMigrateToDrop } = await import('../src/db.js');
  // six snapshots, oldest first: by their text the order would be 3, 2, 4, 5, 1, 6
  const names = [
    'kanban-v7-2026-01-02_10-00-00+0700.db', // 03:00 UTC
    'kanban-v7-2026-01-02-05-00-00.db', //      05:00 UTC, a name made before the offset came in
    'kanban-v7-2026-01-01_22-00-00-0800.db', // 06:00 UTC the next day
    'kanban-v7-2026-01-02-07-00-00.db', //      07:00 UTC
    'kanban-v7-2026-01-02_00-00-00-0800.db', // 08:00 UTC
    'kanban-v7-2026-01-02_16-00-00+0700.db', // 09:00 UTC
  ];
  assert.deepEqual(preMigrateToDrop(names, 2), names.slice(0, 4));
  // the hour that repeats when summer time ends: the first 01:30 is the older one
  assert.deepEqual(preMigrateToDrop(['kanban-v8-2026-11-01_01-30-00-0800.db', 'kanban-v8-2026-11-01_01-30-00-0700.db'], 1),
    ['kanban-v8-2026-11-01_01-30-00-0700.db']);

  // and in a real data folder: the five snapshots of the last five hours were made by the board before the
  // update, under UTC names; west of Greenwich their digits read LATER than the local name of the new one
  for (const TZ of ['Asia/Bangkok', 'America/Los_Angeles']) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-mig-mixed-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    migrateDir(dir);
    const from = stepBack(dir);
    const pre = join(dir, 'backups', 'pre-migrate');
    mkdirSync(pre, { recursive: true });
    const old = [5, 4, 3, 2, 1].map((h) => utcName(from, Date.now() - h * 3_600_000));
    for (const f of old) writeFileSync(join(pre, f), 'x');
    migrateDir(dir, { TZ });
    const left = readdirSync(pre);
    assert.equal(left.length, 5, `${TZ}: expected the five newest, got ${left.join(', ')}`);
    assert.ok(!left.includes(old[0]), `${TZ}: the snapshot of five hours ago should be the one to go: ${left.join(', ')}`);
    assert.ok(left.some((f) => !old.includes(f)), `${TZ}: the snapshot just taken was rotated away`);
  }
});

test('v9: an automations table without repeat gets it, its rules kept as one-shot', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-rep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  const project = db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('p', 'P', 'P')").run().lastInsertRowid;
  db.exec('DROP TABLE automations');
  db.exec(`CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'finished-check', delay_s INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'armed', seen_work INTEGER NOT NULL DEFAULT 0,
    ready_at INTEGER, words TEXT NOT NULL, launch TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, ended_at INTEGER,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, error TEXT)`);
  db.prepare("INSERT INTO automations (project_id, delay_s, words, created_at) VALUES (?, 180, '{}', 1)").run(project);
  db.pragma('user_version = 8');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 9);
  const r = after.prepare('SELECT * FROM automations').get();
  assert.equal(r.repeat, 0);
  assert.equal(r.rearmed_at, null);
  assert.equal(r.fires, '[]');
  assert.equal(r.delay_s, 180);
});

test('v12: task_comments without client_key gets it, its comments kept', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  const project = db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('p', 'P', 'P')").run().lastInsertRowid;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title) VALUES (?, 1, 'T')").run(project).lastInsertRowid;
  db.exec('DROP TABLE task_comments');
  db.exec(`CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT 'me', body TEXT NOT NULL, image TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO task_comments (task_id, body) VALUES (?, 'kept')").run(task);
  db.pragma('user_version = 11');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 12);
  const c = after.prepare('SELECT * FROM task_comments').get();
  assert.equal(c.body, 'kept');
  assert.equal(c.client_key, null);
});

test('v15: a board of v14 gets comment_keys_deleted, tied to its task', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-gone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  db.exec('DROP TABLE comment_keys_deleted');
  db.pragma('user_version = 14');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 15);
  after.pragma('foreign_keys = ON');
  const project = after.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('p', 'P', 'P')").run().lastInsertRowid;
  const task = after.prepare("INSERT INTO tasks (project_id, task_no, title) VALUES (?, 1, 'T')").run(project).lastInsertRowid;
  after.prepare("INSERT INTO comment_keys_deleted (task_id, client_key) VALUES (?, 'k')").run(task);
  assert.throws(() => after.prepare("INSERT INTO comment_keys_deleted (task_id, client_key) VALUES (?, 'k')").run(task), /UNIQUE|PRIMARY/);
  after.prepare('DELETE FROM tasks WHERE id = ?').run(task);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM comment_keys_deleted').get().n, 0);
});

test('v17: a board of v16 gets projects.profile_id, empty for its projects', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-prof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  db.exec('ALTER TABLE projects DROP COLUMN profile_id');
  db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('old', 'Old', 'OL')").run();
  db.pragma('user_version = 16');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 17);
  assert.equal(after.prepare("SELECT profile_id FROM projects WHERE slug = 'old'").get().profile_id, null);
});

// of a pull request
test('v18: a board of v17 gets the base of copies and attempts and the head of a pull request, NULL for its rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  db.exec('ALTER TABLE task_worktrees DROP COLUMN base');
  db.exec('ALTER TABLE task_attempts DROP COLUMN base');
  db.exec('ALTER TABLE task_prs DROP COLUMN head');
  const pid = db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('old', 'Old', 'OL')").run().lastInsertRowid;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title) VALUES (?, 1, 'T')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_worktrees (task_id, path, branch) VALUES (?, '/x', 'claude/OL-1')").run(task);
  db.prepare("INSERT INTO task_attempts (task_id, n, path, branch) VALUES (?, 2, '/y', 'claude/OL-1-a2')").run(task);
  db.prepare("INSERT INTO task_prs (task_id, url, number) VALUES (?, 'https://x/pull/1', 1)").run(task);
  db.pragma('user_version = 17');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 18);
  assert.equal(after.prepare('SELECT base FROM task_worktrees').get().base, null);
  assert.equal(after.prepare('SELECT base FROM task_attempts').get().base, null);
  assert.equal(after.prepare('SELECT head FROM task_prs').get().head, null);
});

// task_worktrees tied to its task
test('v16: a board of v15 gets the columns of copies — 0 for its projects — and task_worktrees', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-wt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  db.exec('DROP TABLE task_worktrees');
  db.exec('ALTER TABLE projects DROP COLUMN worktrees');
  db.exec('ALTER TABLE projects DROP COLUMN worktree_files');
  db.exec('ALTER TABLE projects DROP COLUMN worktree_setup');
  db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('old', 'Old', 'OL')").run();
  db.pragma('user_version = 15');
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  assert.ok(after.pragma('user_version', { simple: true }) >= 16);
  assert.deepEqual(after.prepare("SELECT worktrees, worktree_files, worktree_setup FROM projects WHERE slug = 'old'").get(), { worktrees: 0, worktree_files: null, worktree_setup: null });
  after.pragma('foreign_keys = ON');
  const pid = after.prepare("SELECT id FROM projects WHERE slug = 'old'").get().id;
  const task = after.prepare("INSERT INTO tasks (project_id, task_no, title) VALUES (?, 1, 'T')").run(pid).lastInsertRowid;
  after.prepare("INSERT INTO task_worktrees (task_id, path, branch) VALUES (?, '/x', 'claude/OL-1')").run(task);
  after.prepare('DELETE FROM tasks WHERE id = ?').run(task);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM task_worktrees').get().n, 0, 'the copy goes with its task');
});

test('v14: tasks take the status ready, every row and column kept, foreign keys intact', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-mig-ready-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  migrateDir(dir);
  const db = new Database(join(dir, 'kanban.db'));
  const project = db.prepare("INSERT INTO projects (slug, name, prefix) VALUES ('p', 'P', 'P')").run().lastInsertRowid;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status, pinned, work_truncated) VALUES (?, 7, 'T', 'doing', 1, 3)").run(project).lastInsertRowid;
  db.prepare("INSERT INTO task_comments (task_id, body) VALUES (?, 'kept')").run(task);
  const old = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get().sql.replace("'doing','ready','deploy'", "'doing','deploy'");
  db.pragma('foreign_keys = OFF');
  db.exec(`${old.replace(/CREATE TABLE tasks/, 'CREATE TABLE tasks_old')}; INSERT INTO tasks_old SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_old RENAME TO tasks;`);
  db.prepare("ALTER TABLE projects DROP COLUMN ready_gate").run();
  db.pragma('user_version = 12');
  assert.throws(() => db.prepare("UPDATE tasks SET status = 'ready'").run(), /CHECK/);
  db.close();
  migrateDir(dir);
  const after = new Database(join(dir, 'kanban.db'));
  t.after(() => after.close());
  after.pragma('foreign_keys = ON');
  assert.ok(after.pragma('user_version', { simple: true }) >= 14);
  const r = after.prepare('SELECT * FROM tasks').get();
  assert.equal(r.task_no, 7);
  assert.equal(r.pinned, 1);
  assert.equal(r.work_truncated, 3);
  assert.equal(after.prepare('SELECT ready_gate FROM projects').get().ready_gate, null);
  after.prepare("UPDATE tasks SET status = 'ready'").run();
  assert.equal(after.prepare('SELECT status FROM tasks').get().status, 'ready');
  assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  after.prepare('DELETE FROM tasks').run();
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM task_comments').get().n, 0, 'a comment outlived its task: the foreign key is gone');
  assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_tasks_proj_no'").get(), 'the indexes did not come back');
});
