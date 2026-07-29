CREATE TABLE IF NOT EXISTS projects (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT NOT NULL UNIQUE,
  prefix             TEXT,
  name               TEXT NOT NULL,
  path               TEXT,
  server_path        TEXT,
  deploy_skill       TEXT,
  server             TEXT,
  pm2_services       TEXT,
  domain             TEXT,
  category           TEXT,
  description        TEXT,
  gh_project_number  INTEGER,
  gh_project_id      TEXT,
  gh_status_field_id TEXT,
  gh_status_options  TEXT,
  next_task_no       INTEGER,
  pinned             INTEGER NOT NULL DEFAULT 0,
  position           REAL NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_prefix ON projects(prefix);
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  task_no          INTEGER,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'backlog'
                     CHECK (status IN ('backlog','todo','prep','doing','deploy','review','done','cancelled')),
  priority         INTEGER NOT NULL DEFAULT 0
                     CHECK (priority BETWEEN 0 AND 3),
  labels           TEXT NOT NULL DEFAULT '[]',
  blocked          INTEGER NOT NULL DEFAULT 0,
  blocked_reason   TEXT,
  position         REAL NOT NULL DEFAULT 0,
  work_seconds     INTEGER NOT NULL DEFAULT 0,
  work_started_at  TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0,
  gh_issue_number  INTEGER,
  gh_issue_url     TEXT,
  gh_item_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  done_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status ON tasks(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_proj_no ON tasks(project_id, task_no);
CREATE INDEX IF NOT EXISTS idx_tasks_done_at ON tasks(done_at);
CREATE TABLE IF NOT EXISTS task_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author      TEXT NOT NULL DEFAULT 'me',
  body        TEXT NOT NULL,
  image       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON task_events(created_at);
CREATE TABLE IF NOT EXISTS task_links (
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'related',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, linked_task_id)
);
CREATE INDEX IF NOT EXISTS idx_links_linked ON task_links(linked_task_id);
CREATE TABLE IF NOT EXISTS task_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file        TEXT NOT NULL,
  mime        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_task ON task_attachments(task_id);
CREATE TABLE IF NOT EXISTS task_checklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist(task_id);
CREATE TABLE IF NOT EXISTS horizon_goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scale       TEXT NOT NULL,
  period      TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  parent_id   INTEGER REFERENCES horizon_goals(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_horizon_scale ON horizon_goals(scale, period);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS app_errors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  source    TEXT NOT NULL,
  scope     TEXT,
  message   TEXT NOT NULL,
  detail    TEXT,
  op_id     INTEGER,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_errors_at ON app_errors(id DESC);
CREATE TABLE IF NOT EXISTS sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER,
  op              TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_next ON sync_queue(next_attempt_at);