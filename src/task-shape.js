import { db } from './db.js';

/** SQL: a task is (or, `only` false, is not) one the person does by hand. `alias` — the table's prefix ('t.'). */
export const noclaudeFilter = (alias = '', only = false) => `${alias}labels ${only ? '' : 'NOT '}LIKE '%"noclaude"%'`;
/** A task the person does by hand, by its labels — an array, or the JSON text the database keeps. */
export function isManual(labels) {
  let list = labels;
  if (typeof list === 'string') { try { list = JSON.parse(list || '[]'); } catch { list = []; } }
  return Array.isArray(list) && list.includes('noclaude');
}

export function listShape(t) {
  return {
    id: t.id, key: t.key, project: t.project, title: t.title, status: t.status,
    priority: t.priority, blocked: t.blocked, blocked_reason: t.blocked_reason || null, position: t.position,
    pinned: t.pinned || 0,
    labels: JSON.parse(t.labels || '[]'),
    preview: (t.description || '').slice(0, 180),
    comments_n: t.comments_n || 0,
    attachments_n: t.attachments_n || 0,
    gh_issue_number: t.gh_issue_number,
    gh_issue_url: t.gh_issue_url || null,
    work_seconds: t.work_seconds || 0,
    work_started_at: t.work_started_at || null,
    work_truncated: t.work_truncated || 0,
    updated_at: t.updated_at,
  };
}

export function snapshot(t) {
  return {
    task_id: t.id, project: t.project, key: t.key, title: t.title, description: t.description,
    status: t.status, priority: t.priority, blocked: t.blocked, labels: JSON.parse(t.labels || '[]'),
    gh_issue_number: t.gh_issue_number, gh_item_id: t.gh_item_id,
  };
}

export function taskEvent(id) {
  const row = db.prepare(`
    SELECT t.*, p.slug AS project, (p.prefix || '-' || t.task_no) AS key,
      (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_n,
      (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = t.id AND a.file != '') AS attachments_n
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
  `).get(id);
  return row ? listShape(row) : null;
}
