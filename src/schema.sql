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
  work_truncated   INTEGER NOT NULL DEFAULT 0,
  pinned           INTEGER NOT NULL DEFAULT 0,
  gh_issue_number  INTEGER,
  gh_issue_url     TEXT,
  gh_item_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  done_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status_blocked ON tasks(project_id, status, blocked);
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  session_id  TEXT
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
CREATE TABLE IF NOT EXISTS task_sessions (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  host_session TEXT,
  transcript  TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(session_id);
CREATE TABLE IF NOT EXISTS board_sessions (
  session_id  TEXT PRIMARY KEY,
  launched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_launches (
  event_id  INTEGER PRIMARY KEY REFERENCES task_events(id) ON DELETE CASCADE,
  via       TEXT NOT NULL  -- board | terminal | desktop
);
CREATE TABLE IF NOT EXISTS typed_moves (
  event_id  INTEGER PRIMARY KEY REFERENCES task_events(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL  -- typed | typed-undone | settled
);
CREATE TABLE IF NOT EXISTS typed_backs (
  task_id    INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  event_id   INTEGER NOT NULL,
  at_ms      INTEGER NOT NULL,
  seconds    INTEGER NOT NULL DEFAULT 0,
  truncated  INTEGER NOT NULL DEFAULT 0,
  print      TEXT,
  printed    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_moves (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_no     INTEGER NOT NULL,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  moved_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, task_no)
);
CREATE TABLE IF NOT EXISTS task_usage (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  model       TEXT NOT NULL,
  fast        INTEGER NOT NULL DEFAULT 0,
  answers     INTEGER NOT NULL DEFAULT 0,
  partial     INTEGER NOT NULL DEFAULT 0,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_5m    INTEGER NOT NULL DEFAULT 0,
  cache_1h    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, session_id, day, model, fast)
);
CREATE INDEX IF NOT EXISTS idx_task_usage_day ON task_usage(day);
CREATE INDEX IF NOT EXISTS idx_task_usage_session ON task_usage(session_id);
CREATE TABLE IF NOT EXISTS claude_usage_reads (
  session_id  TEXT PRIMARY KEY,
  transcript  TEXT NOT NULL,
  state       TEXT NOT NULL,
  last        TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
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
  resolved_at TEXT,
  repeats   INTEGER NOT NULL DEFAULT 0
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
  started_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_next ON sync_queue(next_attempt_at);
CREATE TABLE IF NOT EXISTS automations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'finished-check',
  delay_s     INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'armed',
  seen_work   INTEGER NOT NULL DEFAULT 0,
  ready_at    INTEGER,
  words       TEXT NOT NULL,
  launch      TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_automations_state ON automations(state);