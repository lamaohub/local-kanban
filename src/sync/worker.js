import { db, kvGet, kvSet, syncConfigured, logError, resolveErrors, enqueue, SYNC_MAX_ATTEMPTS } from '../db.js';
import { emit } from '../bus.js';
import { taskEvent } from '../task-shape.js';
import * as github from './github.js';

export function syncPaused() {
  return kvGet('sync.paused') === '1';
}

export const ghState = { available: null, lastCheck: 0 };

let draining = false;

async function checkGh() {
  const ttl = ghState.available ? 600000 : 60000;
  if (Date.now() - ghState.lastCheck < ttl) return ghState.available;
  ghState.available = await github.ghAvailable();
  ghState.lastCheck = Date.now();
  return ghState.available;
}

function backoff(attempts) {
  return Math.min(30 * 2 ** attempts, 3600);
}

async function processOp(row) {
  const payload = JSON.parse(row.payload);
  const task = row.task_id
    ? db.prepare('SELECT t.*, p.slug AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(row.task_id)
    : null;
  const slug = task?.project || payload.project;
  let project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  if (!project) return;

  const data = { ...payload, ...(task ? {
    title: task.title, description: task.description, status: task.status,
    priority: task.priority, blocked: task.blocked, labels: JSON.parse(task.labels || '[]'),
    gh_issue_number: task.gh_issue_number, gh_item_id: task.gh_item_id,
  } : {}) };
  if (payload.comment_author) { data.comment_author = payload.comment_author; data.comment_body = payload.comment_body; }
  if (payload.key) data.key = payload.key;

  if (row.op !== 'delete_issue' && !data.gh_issue_number && row.op !== 'create_issue') {
    if (task && !db.prepare("SELECT 1 FROM sync_queue WHERE task_id = ? AND op = 'create_issue'").get(row.task_id)) {
      enqueue('create_issue', row.task_id, { ...data, task_id: row.task_id });
    }
    throw new Error('the issue does not exist yet — waiting for create_issue');
  }

  switch (row.op) {
    case 'create_issue': {
      if (!task) return;
      project = await github.ensureProject(project);
      let { gh_issue_number: number, gh_issue_url: url, gh_item_id: itemId } = task;
      if (!number) {
        ({ number, url } = await github.createIssueOnly(project, data));
        if (db.prepare('UPDATE tasks SET gh_issue_number=?, gh_issue_url=? WHERE id=?').run(number, url, task.id).changes === 0) {
          await github.deleteIssue({ gh_issue_number: number }); return;
        }
      }
      if (!itemId) {
        itemId = await github.addToProject(project, url);
        if (db.prepare('UPDATE tasks SET gh_item_id=? WHERE id=?').run(itemId, task.id).changes === 0) {
          await github.deleteIssue({ gh_issue_number: number }); return;
        }
      }
      await github.setItemStatus(project, itemId, data.status || 'backlog');
      emit('task.updated', taskEvent(task.id));
      break;
    }
    case 'set_status': project = await github.ensureProject(project); await github.setItemStatus(project, data.gh_item_id, data.status); break;
    case 'set_priority': await github.setPriority(data); break;
    case 'set_blocked': await github.setBlocked(data); break;
    case 'set_labels': await github.setLabels(data); break;
    case 'add_comment': await github.addComment(data); break;
    case 'update_issue': await github.updateIssue(data, project); break;
    case 'close_issue': project = await github.ensureProject(project); await github.closeIssue(data, project); break;
    case 'reopen_issue': project = await github.ensureProject(project); await github.reopenIssue(data, project); break;
    case 'delete_issue': await github.deleteIssue(payload); break;
    default: break;
  }
}

export async function drain({ handler = processOp } = {}) {
  if (draining) return;
  if (!syncConfigured()) return;
  if (syncPaused()) return;
  draining = true;
  try {
    const rows = db.prepare(`
      SELECT * FROM sync_queue
      WHERE attempts < ${SYNC_MAX_ATTEMPTS} AND next_attempt_at <= datetime('now')
      ORDER BY id LIMIT 20
    `).all();
    if (!rows.length) return;
    if (!(await checkGh())) return;

    const awaitingCreate = new Set();
    for (const row of rows) {
      if (row.task_id && awaitingCreate.has(row.task_id)) continue;
      try {
        await handler(row);
        db.prepare('DELETE FROM sync_queue WHERE id = ?').run(row.id);
        resolveErrors(row.id);
        kvSet('sync.last_ok', new Date().toISOString().slice(0, 19).replace('T', ' '));
      } catch (err) {
        const attempts = row.attempts + 1;
        const delay = err.permanent ? null : backoff(attempts);
        db.prepare(`UPDATE sync_queue SET attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?`)
          .run(err.permanent ? SYNC_MAX_ATTEMPTS : attempts, String(err.message).slice(0, 500), `+${delay ?? 0} seconds`, row.id);
        emit('sync.status', { error: String(err.message).slice(0, 200), op: row.op });
        logError('sync', row.op, err.message, `attempt ${attempts}, op #${row.id}${row.task_id ? `, task #${row.task_id}` : ''}`, row.id);
        if (row.op === 'create_issue' && row.task_id) awaitingCreate.add(row.task_id);
      }
    }
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE attempts < ${SYNC_MAX_ATTEMPTS}`).get().n;
    emit('sync.status', { pending });
  } finally {
    draining = false;
  }
}

export function kick() {
  setImmediate(() => drain().catch(() => {}));
}

export function startWorker() {
  setInterval(() => drain().catch((e) => logError('sync', 'drain', e?.message || String(e), e?.stack)), 5000);
}
