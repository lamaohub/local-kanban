import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, STATUSES, WORK_SEGMENT_MAX_S, enqueue, nextTaskNo, nextPosition, logError } from '../db.js';
import { scalarQuery } from '../query-params.js';
import { emit } from '../bus.js';
import { resolveProject } from './projects.js';
import { kick } from '../sync/worker.js';
import { LABELS } from '../sync/github.js';
import { repoHttpsBase } from '../repo-base.js';
import { listShape } from '../task-shape.js';

const ATTACH_DIR = join(DATA_DIR, 'attachments');
const ATTACH_MAX = 30;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function taskAttachments(id) {
  return db.prepare("SELECT id, file, mime, created_at FROM task_attachments WHERE task_id = ? AND file != '' ORDER BY id").all(id)
    .map((a) => ({ ...a, url: `/attachments/${id}/${a.file}`, path: join(ATTACH_DIR, String(id), a.file) }));
}

function taskChecklist(id) {
  return db.prepare('SELECT id, text, done, position FROM task_checklist WHERE task_id = ? ORDER BY position, id').all(id)
    .map((c) => ({ ...c, done: !!c.done }));
}

async function commitUrlFor(task) {
  const c = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'git' ORDER BY id DESC LIMIT 1").get(task.id);
  const hash = (c?.body || '').trim().split(/\s/)[0];
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return null;
  const proj = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id);
  const base = await repoHttpsBase(proj?.path);
  return base ? `${base}/commit/${hash}` : null;
}

function attachGitStat(task, startedAt) {
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id);
  if (!project?.path) return;
  const issueNo = task.gh_issue_number;
  let args, gate = null;
  if (issueNo) {
    args = ['-C', project.path, 'log', '-1', '-E', `--grep=#${issueNo}([^0-9]|$)`, '--format=%h|%ct|%s', '--shortstat'];
  } else if (startedAt) {
    args = ['-C', project.path, 'log', '-1', '--format=%h|%ct|%s', '--shortstat'];
    gate = startedAt;
  } else {
    return;
  }
  execFile('git', args, { timeout: 5000 }, (err, stdout) => {
    try {
      if (err) return;
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) return;
      const [hash, ct, ...subj] = (lines[0] || '').split('|');
      if (!hash || !ct) return;
      if (gate && Number(ct) < Math.floor(new Date(gate + 'Z').getTime() / 1000)) return;
      if (db.prepare("SELECT 1 FROM task_comments WHERE task_id = ? AND author = 'git' AND body LIKE ?").get(task.id, hash + ' %')) return;
      const stat = lines[1] ? lines[1].trim() : '';
      const body = `${hash} ${subj.join('|')}${stat ? `\n${stat}` : ''}`;
      const r = db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'git', ?)").run(task.id, body);
      const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
      emit('task.comment', { task_id: task.id, key: task.key, project: task.project, comment: c });
    } catch (e) {
      logError('server', 'attachGitStat', e?.message || String(e), `task #${task.id}`);
    }
  });
}

export const TASK_SELECT = `
  SELECT t.*, p.slug AS project, (p.prefix || '-' || t.task_no) AS key
  FROM tasks t JOIN projects p ON p.id = t.project_id
`;

export function resolveTask(idOrKey) {
  if (/^\d+$/.test(idOrKey)) return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(idOrKey);
  const m = String(idOrKey).match(/^([a-z0-9]+)-(\d+)$/i);
  if (!m) return null;
  return db.prepare(`${TASK_SELECT} WHERE upper(p.prefix) = upper(?) AND t.task_no = ?`).get(m[1], m[2]);
}

export function snapshot(t) {
  return {
    task_id: t.id, project: t.project, key: t.key, title: t.title, description: t.description,
    status: t.status, priority: t.priority, blocked: t.blocked, labels: JSON.parse(t.labels || '[]'),
    gh_issue_number: t.gh_issue_number, gh_item_id: t.gh_item_id,
  };
}

function taskLinks(id) {
  return db.prepare(`
    SELECT t.id, (p.prefix || '-' || t.task_no) AS key, t.title, t.status,
      CASE WHEN l.kind = 'parent' AND l.task_id = @id THEN 'child'
           WHEN l.kind = 'parent' AND l.linked_task_id = @id THEN 'parent'
           ELSE 'related' END AS rel
    FROM task_links l
    JOIN tasks t ON t.id = CASE WHEN l.task_id = @id THEN l.linked_task_id ELSE l.task_id END
    JOIN projects p ON p.id = t.project_id
    WHERE l.task_id = @id OR l.linked_task_id = @id
    ORDER BY rel, t.id
  `).all({ id });
}

function removeLinkPair(a, b) {
  db.prepare('DELETE FROM task_links WHERE (task_id = ? AND linked_task_id = ?) OR (task_id = ? AND linked_task_id = ?)')
    .run(a, b, b, a);
}

function placeAdjacent(a, b) {
  if (a.status !== b.status || a.project_id !== b.project_id) return;
  const next = db.prepare('SELECT MIN(position) AS p FROM tasks WHERE status=? AND project_id=? AND position > ? AND id != ?')
    .get(a.status, a.project_id, a.position, b.id);
  const newPos = next && next.p != null ? (a.position + next.p) / 2 : a.position + 1;
  db.prepare("UPDATE tasks SET position = ?, updated_at = datetime('now') WHERE id = ?").run(newPos, b.id);
}

function normalizeLabels(v) {
  if (!Array.isArray(v)) return null;
  return v.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim());
}

function unknownLabels(arr) {
  return arr.filter((l) => !Object.prototype.hasOwnProperty.call(LABELS, l));
}
function labelPaletteError(bad) {
  return { error: `unknown labels: ${bad.join(', ')} — they are not in the palette and the GitHub sync would fail. Allowed: ${Object.keys(LABELS).join(', ')}` };
}

export default async function taskRoutes(app) {
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: 6 * 1024 * 1024 }, (req, body, done) => done(null, body));

  app.get('/api/tasks', (req, reply) => {
    const parsed = scalarQuery(req.query, ['project', 'status', 'all', 'q']);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });
    const { project, status, all, q } = parsed.values;
    const p = project ? resolveProject(project) : null;
    if (project && !p) return reply.code(404).send({ error: 'project not found' });
    let sql = `
      SELECT t.id, t.project_id, t.task_no, t.title, substr(t.description, 1, 180) AS description,
        t.status, t.priority, t.blocked, t.blocked_reason, t.position, t.pinned,
        t.work_seconds, t.work_started_at, t.work_truncated,
        t.gh_issue_number, t.gh_issue_url, t.updated_at, t.labels,
        p.slug AS project, (p.prefix || '-' || t.task_no) AS key,
        (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_n,
        (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = t.id AND a.file != '') AS attachments_n
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE 1=1`;
    const args = [];
    if (p) { sql += ' AND t.project_id = ?'; args.push(p.id); }
    else sql += ' AND p.archived = 0';
    if (status) { sql += ' AND t.status = ?'; args.push(status); }
    else if (!all) sql += " AND t.status NOT IN ('done','cancelled','backlog')";
    if (q) {
      sql += ` AND (instr(kb_lower(t.title), kb_lower(?)) > 0
        OR instr(kb_lower(t.description), kb_lower(?)) > 0
        OR instr(kb_lower(p.prefix || '-' || t.task_no), kb_lower(?)) > 0
        OR instr(kb_lower(t.labels), kb_lower(?)) > 0)`;
      args.push(q, q, q, q);
    }
    sql += ' ORDER BY t.status, t.priority DESC, t.position, t.id';
    const list = db.prepare(sql).all(...args).map(listShape);
    const linkMap = {};
    const shownIds = list.map((t) => t.id);
    const linkRows = shownIds.length
      ? db.prepare(`SELECT task_id, linked_task_id FROM task_links
                    WHERE task_id IN (${shownIds.map(() => '?').join(',')})
                       OR linked_task_id IN (${shownIds.map(() => '?').join(',')})`).all(...shownIds, ...shownIds)
      : [];
    for (const { task_id, linked_task_id } of linkRows) {
      (linkMap[task_id] ||= []).push(linked_task_id);
      (linkMap[linked_task_id] ||= []).push(task_id);
    }
    for (const t of list) t.linked_ids = linkMap[t.id] || [];
    return list;
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const events = db.prepare('SELECT status, created_at FROM task_events WHERE task_id = ? ORDER BY id').all(t.id);
    return { ...t, labels: JSON.parse(t.labels || '[]'), events, links: taskLinks(t.id), attachments: taskAttachments(t.id), checklist: taskChecklist(t.id), commit_url: await commitUrlFor(t) };
  });

  app.post('/api/tasks', (req, reply) => {
    const { project, priority = 0, status = 'backlog', labels = [] } = req.body || {};
    const title = String(req.body?.title ?? '');
    const description = String(req.body?.description ?? '');
    if (!project) return reply.code(400).send({ error: 'project required' });
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: 'bad status' });
    if (!['backlog', 'todo'].includes(status)) {
      return reply.code(400).send({ error: 'a task can only be created in Backlog or To do — everything else has to go through the working statuses' });
    }
    const p = resolveProject(project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) return reply.code(400).send({ error: 'priority: an integer 0-3' });
    const labelsArr = normalizeLabels(labels);
    if (labelsArr === null) return reply.code(400).send({ error: 'labels: an array of strings' });
    const badCreate = unknownLabels(labelsArr);
    if (badCreate.length) return reply.code(400).send(labelPaletteError(badCreate));
    const pos = nextPosition(p.id, status);
    const r = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, priority, status, labels, position) VALUES (?,?,?,?,?,?,?,?)')
      .run(p.id, nextTaskNo(p.id), title, description, priority, status, JSON.stringify(labelsArr), pos);
    const t = resolveTask(String(r.lastInsertRowid));
    enqueue('create_issue', t.id, snapshot(t));
    kick();
    emit('task.created', listShape({ ...t, comments_n: 0 }));
    return reply.code(201).send({ ...t, labels: JSON.parse(t.labels) });
  });

  app.post('/api/tasks/:id/duplicate', (req, reply) => {
    const src = taskOr404(req, reply); if (!src) return reply;
    const status = ['backlog', 'todo'].includes(src.status) ? src.status : 'todo';
    const pos = nextPosition(src.project_id, status);
    const r = db.prepare('INSERT INTO tasks (project_id, task_no, title, description, priority, status, labels, position) VALUES (?,?,?,?,?,?,?,?)')
      .run(src.project_id, nextTaskNo(src.project_id), `${src.title} (copy)`, src.description, src.priority, status, src.labels, pos);
    const t = resolveTask(String(r.lastInsertRowid));
    enqueue('create_issue', t.id, snapshot(t));
    kick();
    emit('task.created', listShape({ ...t, comments_n: 0 }));
    return reply.code(201).send({ ...t, labels: JSON.parse(t.labels) });
  });

  app.patch('/api/tasks/:id', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const b = req.body || {};
    const updates = [];
    const values = [];

    if (b.title !== undefined) { updates.push('title = ?'); values.push(String(b.title ?? '')); }
    if (b.description !== undefined) { updates.push('description = ?'); values.push(String(b.description ?? '')); }
    if (b.priority !== undefined) {
      if (!Number.isInteger(b.priority) || b.priority < 0 || b.priority > 3) return reply.code(400).send({ error: 'priority: an integer 0-3' });
      updates.push('priority = ?'); values.push(b.priority);
    }
    if (b.labels !== undefined) {
      const labelsArr = normalizeLabels(b.labels);
      if (labelsArr === null) return reply.code(400).send({ error: 'labels: an array of strings' });
      const badPatch = unknownLabels(labelsArr);
      if (badPatch.length) return reply.code(400).send(labelPaletteError(badPatch));
      updates.push('labels = ?'); values.push(JSON.stringify(labelsArr));
    }
    if (b.blocked !== undefined) {
      updates.push('blocked = ?'); values.push(b.blocked ? 1 : 0);
      updates.push('blocked_reason = ?'); values.push(b.blocked ? (b.blocked_reason || '') : null);
    }
    if (b.position !== undefined) {
      if (typeof b.position !== 'number' && typeof b.position !== 'string') {
        return reply.code(400).send({ error: 'position: a finite number' });
      }
      const pos = Number(b.position);
      if (!Number.isFinite(pos)) return reply.code(400).send({ error: 'position: a finite number' });
      updates.push('position = ?'); values.push(pos);
    }
    if (b.pinned !== undefined) { updates.push('pinned = ?'); values.push(b.pinned ? 1 : 0); }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return reply.code(400).send({ error: 'bad status' });
      const effLabels = b.labels !== undefined ? (normalizeLabels(b.labels) || []) : JSON.parse(t.labels || '[]');
      const isNoclaude = Array.isArray(effLabels) && effLabels.includes('noclaude');
      if (!isNoclaude && ['backlog', 'todo'].includes(t.status) && ['review', 'done'].includes(b.status)) {
        return reply.code(400).send({ error: `cannot go straight from "${t.status}" to "${b.status}" — it has to pass through the working statuses` });
      }
      updates.push('status = ?'); values.push(b.status);
      if (b.status === 'done' && t.status !== 'done') updates.push("done_at = datetime('now')");
      else if (b.status !== 'done' && t.status === 'done') updates.push('done_at = NULL');
      const working = (s) => s === 'doing' || s === 'deploy';
      if (working(b.status) && !working(t.status)) {
        updates.push("work_started_at = datetime('now')");
      } else if (!working(b.status) && working(t.status)) {
        updates.push("work_seconds = work_seconds + MIN(?, COALESCE(CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', work_started_at) AS INTEGER), 0))");
        values.push(WORK_SEGMENT_MAX_S);
        updates.push("work_truncated = work_truncated + (COALESCE(CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', work_started_at) AS INTEGER), 0) > ?)");
        values.push(WORK_SEGMENT_MAX_S);
        updates.push('work_started_at = NULL');
      }
      if (b.status !== t.status && b.position === undefined) {
        const pos = nextPosition(t.project_id, b.status);
        updates.push('position = ?'); values.push(pos);
      }
    }

    if (!updates.length) return { ...t, labels: JSON.parse(t.labels || '[]') };
    values.push(t.id);
    const statusChanged = b.status !== undefined && b.status !== t.status;
    const applyPatch = db.transaction(() => {
      db.prepare(`UPDATE tasks SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
      const f = resolveTask(String(t.id));

      if (b.title !== undefined || b.description !== undefined) enqueue('update_issue', f.id, snapshot(f));
      if (b.priority !== undefined && b.priority !== t.priority) enqueue('set_priority', f.id, snapshot(f));
      if (b.labels !== undefined) enqueue('set_labels', f.id, snapshot(f));
      if (b.blocked !== undefined && (b.blocked ? 1 : 0) !== t.blocked) enqueue('set_blocked', f.id, snapshot(f));
      if (statusChanged) {
        db.prepare('INSERT INTO task_events (task_id, status) VALUES (?, ?)').run(t.id, b.status);
        const closed = (s) => s === 'done' || s === 'cancelled';
        if (closed(b.status)) enqueue('close_issue', f.id, snapshot(f));
        else if (closed(t.status)) enqueue('reopen_issue', f.id, snapshot(f));
        else enqueue('set_status', f.id, snapshot(f));
      }
      return f;
    });
    const fresh = applyPatch();

    if (statusChanged && b.status === 'review') attachGitStat(fresh, t.work_started_at);
    kick();

    emit('task.updated', { ...listShape({ ...fresh, comments_n: undefined }), prev_status: t.status });
    return { ...fresh, labels: JSON.parse(fresh.labels || '[]') };
  });

  app.delete('/api/tasks/:id', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    db.prepare('DELETE FROM sync_queue WHERE task_id = ?').run(t.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    try { rmSync(join(ATTACH_DIR, String(t.id)), { recursive: true, force: true }); } catch {  }
    if (t.gh_issue_number) { enqueue('delete_issue', null, snapshot(t)); kick(); }
    emit('task.deleted', { id: t.id, key: t.key, project: t.project });
    return reply.code(204).send();
  });

  const withCommentImg = (c, taskId) => (c.image
    ? { ...c, image_url: `/attachments/${taskId}/${c.image}`, image_path: join(ATTACH_DIR, String(taskId), c.image) }
    : c);

  app.get('/api/tasks/:id/comments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id').all(t.id).map((c) => withCommentImg(c, t.id));
  });

  app.post('/api/tasks/:id/comments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (mime.startsWith('image/')) {
      const ext = MIME_EXT[mime];
      if (!ext) return reply.code(400).send({ error: 'images only: png, jpeg, webp, gif' });
      const buf = req.body;
      if (!buf || !buf.length) return reply.code(400).send({ error: 'empty body' });
      const imgs = db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND image IS NOT NULL AND image != ''").get(t.id).n;
      if (imgs >= ATTACH_MAX) return reply.code(400).send({ error: `limit of images in comments: ${ATTACH_MAX}` });
      const r = db.prepare("INSERT INTO task_comments (task_id, author, body, image) VALUES (?, 'me', '', '')").run(t.id);
      const file = `c${r.lastInsertRowid}.${ext}`;
      try {
        mkdirSync(join(ATTACH_DIR, String(t.id)), { recursive: true });
        writeFileSync(join(ATTACH_DIR, String(t.id), file), buf);
      } catch {
        db.prepare('DELETE FROM task_comments WHERE id = ?').run(r.lastInsertRowid);
        return reply.code(500).send({ error: 'could not save the file' });
      }
      db.prepare('UPDATE task_comments SET image = ? WHERE id = ?').run(file, r.lastInsertRowid);
      const c = withCommentImg(db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid), t.id);
      emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comment: c });
      return reply.code(201).send(c);
    }
    const { body, author = 'me' } = req.body || {};
    if (!body || !String(body).trim()) return reply.code(400).send({ error: 'body required' });
    const r = db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?,?,?)')
      .run(t.id, author === 'claude' ? 'claude' : 'me', String(body).trim());
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
    enqueue('add_comment', t.id, { ...snapshot(t), comment_author: c.author, comment_body: c.body });
    kick();
    emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comment: c });
    return reply.code(201).send(c);
  });

  app.delete('/api/tasks/:id/comments/:commentId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const c = db.prepare('SELECT * FROM task_comments WHERE id = ? AND task_id = ?').get(req.params.commentId, t.id);
    if (!c) return reply.code(404).send({ error: 'comment not found' });
    if (c.image) { try { rmSync(join(ATTACH_DIR, String(t.id), c.image), { force: true }); } catch {  } }
    db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
    emit('task.comment', { task_id: t.id, key: t.key, project: t.project });
    return reply.code(204).send();
  });

  const taskOr404 = (req, reply, id = req.params.id, err = 'task not found') => {
    const found = resolveTask(id);
    if (!found) { reply.code(404).send({ error: err }); return null; }
    return found;
  };

  app.post('/api/tasks/:id/links', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const other = req.body?.key
      ? taskOr404(req, reply, req.body.key, 'the task to link to was not found')
      : (reply.code(404).send({ error: 'the task to link to was not found' }), null);
    if (!other) return reply;
    if (other.id === t.id) return reply.code(400).send({ error: 'a task cannot be linked to itself' });
    const rel = ['child', 'parent'].includes(req.body?.rel) ? req.body.rel : 'related';
    removeLinkPair(t.id, other.id);
    if (rel === 'child') db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'parent')").run(t.id, other.id);
    else if (rel === 'parent') db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'parent')").run(other.id, t.id);
    else { const [a, b] = [t.id, other.id].sort((x, y) => x - y); db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'related')").run(a, b); }
    placeAdjacent(t, other);
    emit('task.linked', { id: t.id, key: t.key });
    return taskLinks(t.id);
  });

  app.delete('/api/tasks/:id/links/:linkedId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const other = taskOr404(req, reply, req.params.linkedId, 'the task to link to was not found');
    if (!other) return reply;
    removeLinkPair(t.id, other.id);
    emit('task.linked', { id: t.id, key: t.key });
    return taskLinks(t.id);
  });

  app.post('/api/tasks/:id/attachments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = MIME_EXT[mime];
    if (!ext) return reply.code(400).send({ error: 'images only: png, jpeg, webp, gif' });
    const buf = req.body;
    if (!buf || !buf.length) return reply.code(400).send({ error: 'empty body' });
    const n = db.prepare("SELECT COUNT(*) AS n FROM task_attachments WHERE task_id = ? AND file != ''").get(t.id).n;
    if (n >= ATTACH_MAX) return reply.code(400).send({ error: `limit of attachments per task: ${ATTACH_MAX}` });
    const r = db.prepare('INSERT INTO task_attachments (task_id, file, mime) VALUES (?,?,?)').run(t.id, '', mime);
    const file = `${r.lastInsertRowid}.${ext}`;
    try {
      mkdirSync(join(ATTACH_DIR, String(t.id)), { recursive: true });
      writeFileSync(join(ATTACH_DIR, String(t.id), file), buf);
    } catch {
      db.prepare('DELETE FROM task_attachments WHERE id = ?').run(r.lastInsertRowid);
      return reply.code(500).send({ error: 'could not save the file' });
    }
    db.prepare('UPDATE task_attachments SET file = ? WHERE id = ?').run(file, r.lastInsertRowid);
    emit('task.attached', { task_id: t.id, key: t.key });
    return reply.code(201).send({ id: r.lastInsertRowid, file, mime, url: `/attachments/${t.id}/${file}` });
  });

  app.get('/api/tasks/:id/attachments', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return taskAttachments(t.id);
  });

  app.delete('/api/tasks/:id/attachments/:attachmentId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const a = db.prepare('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, t.id);
    if (!a) return reply.code(404).send({ error: 'attachment not found' });
    try { rmSync(join(ATTACH_DIR, String(t.id), a.file), { force: true }); } catch {  }
    db.prepare('DELETE FROM task_attachments WHERE id = ?').run(a.id);
    emit('task.attached', { task_id: t.id, key: t.key });
    return reply.code(204).send();
  });

  app.get('/api/tasks/:id/checklist', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return taskChecklist(t.id);
  });

  app.post('/api/tasks/:id/checklist', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const text = (req.body?.text ?? '').toString();
    const mx = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM task_checklist WHERE task_id = ?').get(t.id).m;
    const r = db.prepare('INSERT INTO task_checklist (task_id, text, position) VALUES (?,?,?)').run(t.id, text, mx + 1);
    return reply.code(201).send({ id: r.lastInsertRowid, text, done: false, position: mx + 1 });
  });

  app.patch('/api/tasks/:id/checklist/:itemId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const item = db.prepare('SELECT * FROM task_checklist WHERE id = ? AND task_id = ?').get(req.params.itemId, t.id);
    if (!item) return reply.code(404).send({ error: 'checklist item not found' });
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.text !== undefined) {
      if (b.text === null || typeof b.text === 'object') return reply.code(400).send({ error: 'text: expected a string' });
      sets.push('text = ?'); vals.push(String(b.text));
    }
    if (b.done !== undefined) { sets.push('done = ?'); vals.push(b.done ? 1 : 0); }
    if (sets.length) { db.prepare(`UPDATE task_checklist SET ${sets.join(', ')} WHERE id = ?`).run(...vals, item.id); }
    const fresh = db.prepare('SELECT id, text, done, position FROM task_checklist WHERE id = ?').get(item.id);
    return { ...fresh, done: !!fresh.done };
  });

  app.delete('/api/tasks/:id/checklist/:itemId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const item = db.prepare('SELECT * FROM task_checklist WHERE id = ? AND task_id = ?').get(req.params.itemId, t.id);
    if (!item) return reply.code(404).send({ error: 'checklist item not found' });
    db.prepare('DELETE FROM task_checklist WHERE id = ?').run(item.id);
    return reply.code(204).send();
  });
}
