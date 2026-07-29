import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function migrateDir(dir) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js';"], {
    cwd: ROOT,
    env: { ...process.env, KB_DATA_DIR: dir, KB_GH_OWNER: '', KB_GH_REPO: '' },
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
