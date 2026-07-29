import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ROOT, langOverride, ghOwnerEnv, ghRepoEnv } from './config.js';

export { DATA_DIR };

mkdirSync(DATA_DIR, { recursive: true });

const MIGRATIONS = [
  { v: 1, name: 'legacy-consolidation-2026-07', up: legacyMigrate, ownTx: true },
  { v: 2, name: 'app-errors-resolved', up: () => {
    const cols = db.prepare('PRAGMA table_info(app_errors)').all();
    if (!cols.length) return;
    const has = (col) => cols.some((c) => c.name === col);
    if (!has('op_id')) db.exec('ALTER TABLE app_errors ADD COLUMN op_id INTEGER');
    if (!has('resolved_at')) db.exec('ALTER TABLE app_errors ADD COLUMN resolved_at TEXT');
  } },
  { v: 3, name: 'locked-categories-en', up: () => {
    const cols = db.prepare('PRAGMA table_info(projects)').all();
    if (!cols.some((c) => c.name === 'category')) return;
    db.prepare("UPDATE projects SET category = 'Local' WHERE category = 'Локальные'").run();
    db.prepare("UPDATE projects SET category = 'Other' WHERE category = 'Прочее'").run();
  } },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1).v;

export const db = new Database(join(DATA_DIR, 'kanban.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

migrate();
db.exec(readFileSync(join(ROOT, 'src', 'schema.sql'), 'utf8'));
backfill();

export const SYNC_MAX_ATTEMPTS = 15;

export const STATUSES = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review', 'done', 'cancelled'];

function migrate() {
  const from = db.pragma('user_version', { simple: true });
  if (from >= SCHEMA_VERSION) return;
  preMigrateBackup(from);
  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    if (m.ownTx) {
      m.up();
      db.pragma(`user_version = ${m.v}`);
    } else {
      db.transaction(() => {
        m.up();
        db.pragma(`user_version = ${m.v}`);
      })();
    }
  }
}

function preMigrateBackup(fromVersion) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) return;
  const dir = join(DATA_DIR, 'backups', 'pre-migrate');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const target = join(dir, `kanban-v${fromVersion}-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const f of files.slice(0, -5)) rmSync(join(dir, f), { force: true });
}

function legacyMigrate() {
  const tasksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql;
  if (tasksSql && !tasksSql.includes('backlog')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE new_tasks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id       INTEGER NOT NULL REFERENCES projects(id),
        task_no          INTEGER,
        title            TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'backlog'
                           CHECK (status IN ('backlog','todo','doing','deploy','review','done','cancelled')),
        priority         INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
        labels           TEXT NOT NULL DEFAULT '[]',
        blocked          INTEGER NOT NULL DEFAULT 0,
        blocked_reason   TEXT,
        position         REAL NOT NULL DEFAULT 0,
        gh_issue_number  INTEGER,
        gh_issue_url     TEXT,
        gh_item_id       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        done_at          TEXT
      );
      INSERT INTO new_tasks (id, project_id, title, description, status, priority, blocked, blocked_reason,
                             position, gh_issue_number, gh_issue_url, gh_item_id, created_at, updated_at, done_at)
        SELECT id, project_id, title, description, status, priority, blocked, blocked_reason,
               position, gh_issue_number, gh_issue_url, gh_item_id, created_at, updated_at, done_at
        FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE new_tasks RENAME TO tasks;
      DROP INDEX IF EXISTS idx_tasks_proj_status;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }
  const projCols = db.prepare("SELECT name FROM pragma_table_info('projects')").all().map((c) => c.name);
  if (projCols.length && !projCols.includes('prefix')) db.exec('ALTER TABLE projects ADD COLUMN prefix TEXT');

  const taskCols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  if (taskCols.length && !taskCols.includes('work_seconds')) {
    db.exec('ALTER TABLE tasks ADD COLUMN work_seconds INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE tasks ADD COLUMN work_started_at TEXT');
  }
  if (projCols.length && !projCols.includes('next_task_no')) db.exec('ALTER TABLE projects ADD COLUMN next_task_no INTEGER');
  if (projCols.length && !projCols.includes('description')) db.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  if (projCols.length && !projCols.includes('pinned')) db.exec('ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (projCols.length && !projCols.includes('position')) db.exec('ALTER TABLE projects ADD COLUMN position REAL NOT NULL DEFAULT 0');

  const curTasksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get()?.sql;
  if (curTasksSql && !curTasksSql.includes("'prep'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE new_tasks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id       INTEGER NOT NULL REFERENCES projects(id),
        task_no          INTEGER,
        title            TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'backlog'
                           CHECK (status IN ('backlog','todo','prep','doing','deploy','review','done','cancelled')),
        priority         INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
        labels           TEXT NOT NULL DEFAULT '[]',
        blocked          INTEGER NOT NULL DEFAULT 0,
        blocked_reason   TEXT,
        position         REAL NOT NULL DEFAULT 0,
        work_seconds     INTEGER NOT NULL DEFAULT 0,
        work_started_at  TEXT,
        gh_issue_number  INTEGER,
        gh_issue_url     TEXT,
        gh_item_id       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        done_at          TEXT
      );
      INSERT INTO new_tasks (id, project_id, task_no, title, description, status, priority, labels,
                             blocked, blocked_reason, position, work_seconds, work_started_at,
                             gh_issue_number, gh_issue_url, gh_item_id, created_at, updated_at, done_at)
        SELECT id, project_id, task_no, title, description, status, priority, labels,
               blocked, blocked_reason, position, work_seconds, work_started_at,
               gh_issue_number, gh_issue_url, gh_item_id, created_at, updated_at, done_at
        FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE new_tasks RENAME TO tasks;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  const tCols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  if (tCols.length && !tCols.includes('pinned')) db.exec('ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  const lCols = db.prepare("SELECT name FROM pragma_table_info('task_links')").all().map((c) => c.name);
  if (lCols.length && !lCols.includes('kind')) db.exec("ALTER TABLE task_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'related'");
  const cCols = db.prepare("SELECT name FROM pragma_table_info('task_comments')").all().map((c) => c.name);
  if (cCols.length && !cCols.includes('image')) db.exec('ALTER TABLE task_comments ADD COLUMN image TEXT');
}

export function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

const ERRORS_KEEP = 300;
export function logError(source, scope, message, detail, opId = null) {
  try {
    db.prepare('INSERT INTO app_errors(source, scope, message, detail, op_id) VALUES(?, ?, ?, ?, ?)')
      .run(String(source), scope ? String(scope).slice(0, 200) : null, String(message).slice(0, 500), detail ? String(detail).slice(0, 2000) : null, opId ?? null);
    db.prepare('DELETE FROM app_errors WHERE id NOT IN (SELECT id FROM app_errors ORDER BY id DESC LIMIT ?)').run(ERRORS_KEEP);
  } catch {  }
}

export function resolveErrors(opId) {
  if (!opId) return;
  try {
    db.prepare("UPDATE app_errors SET resolved_at = datetime('now') WHERE op_id = ? AND resolved_at IS NULL").run(opId);
  } catch {  }
}

export function uiLang() {
  const v = langOverride() || kvGet('ui.lang') || 'ru';
  return v === 'en' ? 'en' : 'ru';
}

export function ghOwner() { return ghOwnerEnv() || kvGet('gh.owner') || ''; }
export function ghRepo() { return ghRepoEnv() || kvGet('gh.repo') || ''; }
export function syncConfigured() { return Boolean(ghOwner() && ghRepo()); }

function backfill() {
  const used = usedPrefixes();
  for (const p of db.prepare('SELECT id, slug FROM projects WHERE prefix IS NULL').all()) {
    const prefix = genPrefix(p.slug, used);
    used.add(prefix);
    db.prepare('UPDATE projects SET prefix = ? WHERE id = ?').run(prefix, p.id);
  }
  db.exec(`
    UPDATE tasks SET task_no = (
      SELECT COUNT(*) FROM tasks t2 WHERE t2.project_id = tasks.project_id AND t2.id <= tasks.id
    ) WHERE task_no IS NULL;
  `);
  db.exec(`
    INSERT INTO task_events (task_id, status, created_at)
    SELECT id, status, done_at FROM tasks
    WHERE done_at IS NOT NULL AND status IN ('done','cancelled')
      AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = tasks.id);
  `);
}

export function genPrefix(slug, used = new Set()) {
  const words = slug.replace(/[^a-z0-9-]/gi, '').split('-').filter(Boolean);
  let base = words.length >= 2
    ? words.map((w) => w[0]).join('').slice(0, 3).toUpperCase()
    : slug.slice(0, 3).toUpperCase();
  if (base.length < 2) base = (base + 'XX').slice(0, 2);
  let prefix = base;
  let n = 2;
  while (used.has(prefix)) prefix = base + n++;
  return prefix;
}

export function nextPosition(projectId, status) {
  return db.prepare('SELECT COALESCE(MAX(position),0) AS mx FROM tasks WHERE project_id=? AND status=?')
    .get(projectId, status).mx + 1;
}

export function usedPrefixes() {
  return new Set(db.prepare('SELECT upper(prefix) AS p FROM projects WHERE prefix IS NOT NULL').all().map((r) => r.p));
}
export const makePrefix = (slug) => genPrefix(slug, usedPrefixes());

export function nextTaskNo(projectId) {
  db.prepare(`
    UPDATE projects SET next_task_no = COALESCE(
      next_task_no,
      (SELECT COALESCE(MAX(task_no), 0) FROM tasks WHERE project_id = ?) + 1
    ) WHERE id = ?
  `).run(projectId, projectId);
  const { n } = db.prepare('SELECT next_task_no AS n FROM projects WHERE id = ?').get(projectId);
  db.prepare('UPDATE projects SET next_task_no = next_task_no + 1 WHERE id = ?').run(projectId);
  return n;
}

export function enqueue(op, taskId, payload) {
  if (!syncConfigured()) return;
  if (taskId && ['set_status', 'set_priority', 'set_blocked', 'set_labels', 'update_issue'].includes(op)) {
    db.prepare('DELETE FROM sync_queue WHERE task_id = ? AND op = ?').run(taskId, op);
  }
  db.prepare('INSERT INTO sync_queue (task_id, op, payload) VALUES (?, ?, ?)')
    .run(taskId, op, JSON.stringify(payload));
}
