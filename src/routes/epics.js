import { followEpic, resolveTask } from './tasks.js';
import { addBatch, batchByName, deleteBatch, epicOf, epicView, orderBatches, placeProblem, placeTask, planFileName, planOf, planProblem, renameBatch,
  saveSettings, savePlan, settingsProblem, titleProblem } from '../epics.js';
import { taskEvent } from '../task-shape.js';
import { runBatch, runProblem, stopBatch } from '../epic-run.js';
import { requestSession } from '../claude-sessions.js';
import { scalarParam } from '../query-params.js';
import { emit } from '../bus.js';
import { db } from '../db.js';

const linkedOf = (id) => db.prepare('SELECT linked_task_id AS o FROM task_links WHERE task_id = ? UNION SELECT task_id FROM task_links WHERE linked_task_id = ?').all(id, id).map((r) => r.o);

export default async function epicRoutes(app) {
  const taskOr404 = (req, reply) => {
    const t = resolveTask(req.params.id);
    if (!t) reply.code(404).send({ error: 'task not found' });
    return t;
  };
  const versionOf = (req, reply) => {
    const { value: v, error } = scalarParam(req.query?.version, 'version');
    if (error) { reply.code(400).send({ error, field: 'version' }); return undefined; }
    if (v === undefined || v === '') return null;
    if (!/^\d{1,9}$/.test(v)) { reply.code(400).send({ error: 'version: expected a number', field: 'version' }); return undefined; }
    return Number(v);
  };

  app.get('/api/tasks/:id/plan', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const v = versionOf(req, reply); if (v === undefined) return reply;
    const plan = planOf(t.id, v);
    if (!plan) return reply.code(404).send({ error: v == null ? `${t.key} has no plan` : `${t.key} has no version ${v} of its plan`, reason: 'no-plan' });
    return { key: t.key, ...plan };
  });

  // the plan as a file: the current version, or ?version=N
  app.get('/api/tasks/:id/plan.md', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const v = versionOf(req, reply); if (v === undefined) return reply;
    const plan = planOf(t.id, v);
    if (!plan) return reply.code(404).send({ error: `${t.key} has no plan`, reason: 'no-plan' });
    return reply.header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${planFileName(t.key, v)}"`)
      .send(plan.body);
  });

  /* ── Batches ── every change answers with the epic's view and tells the board: the epic's card (its progress) and the
     open card of the epic (`task.epic`). */
  const told = (epic) => {
    emit('task.updated', taskEvent(epic.id));
    emit('task.epic', { id: epic.id, key: epic.key });
    return { key: epic.key, ...epicView(epic.id) };
  };
  const batchId = (req, reply) => {
    const v = Number(req.params.batchId);
    if (!Number.isInteger(v) || v < 1) { reply.code(404).send({ error: 'no such batch in this epic' }); return null; }
    return v;
  };

  app.get('/api/tasks/:id/epic', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return { key: t.key, ...epicView(t.id) };
  });

  // the epic's settings: `portion` — how many tasks of a batch one start takes, `auto_next` — the next batch starts by itself
  app.patch('/api/tasks/:id/epic', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const problem = settingsProblem(req.body);
    if (problem) return reply.code(400).send(problem);
    saveSettings(t.id, req.body || {});
    return told(t);
  });

  app.post('/api/tasks/:id/batches', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const problem = titleProblem(req.body?.title);
    if (problem) return reply.code(400).send({ error: problem, field: 'title' });
    addBatch(t.id, req.body?.title || '');
    return told(t);
  });

  app.put('/api/tasks/:id/batches/order', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const err = orderBatches(t.id, req.body?.batches);
    if (err) return reply.code(400).send({ error: err, field: 'batches' });
    return told(t);
  });

  app.patch('/api/tasks/:id/batches/:batchId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const id = batchId(req, reply); if (!id) return reply;
    const problem = titleProblem(req.body?.title);
    if (problem || req.body?.title === undefined) return reply.code(400).send({ error: problem || 'title: expected a string', field: 'title' });
    if (!renameBatch(t.id, id, req.body.title)) return reply.code(404).send({ error: 'no such batch in this epic' });
    return told(t);
  });

  app.delete('/api/tasks/:id/batches/:batchId', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const id = batchId(req, reply); if (!id) return reply;
    if (!deleteBatch(t.id, id)) return reply.code(404).send({ error: 'no such batch in this epic' });
    const out = told(t);
    followEpic(t.id); // its tasks left the batches: what the epic waits for changed
    return out;
  });

  /* A task into one of the epic's batches: `batch` — the batch's id, or `batch_name` — its number or title (a title not
     there makes the batch at the end; `kb add --batch`), or `batch: null` — into none (it stays a sub-task); `before` — the
     key of the task to stand before, none — at the end. The task becomes a sub-task of the epic if it was not. */
  app.post('/api/tasks/:id/epic/place', (req, reply) => {
    const epic = taskOr404(req, reply); if (!epic) return reply;
    const b = req.body || {};
    if (typeof b.key !== 'string' && typeof b.key !== 'number') return reply.code(400).send({ error: 'key: the task to place', field: 'key' });
    const task = resolveTask(String(b.key));
    if (!task) return reply.code(404).send({ error: 'the task to place was not found', field: 'key' });
    const refused = placeProblem(epic, task); // before a batch is made by its title
    if (refused) return reply.code(refused.code).send({ error: refused.error, field: refused.field });
    let batch = null;
    if (b.batch_name !== undefined) {
      if (typeof b.batch_name !== 'string' && typeof b.batch_name !== 'number') return reply.code(400).send({ error: 'batch_name: a number or a title', field: 'batch' });
      const problem = titleProblem(String(b.batch_name));
      if (problem || !String(b.batch_name).trim()) return reply.code(400).send({ error: problem || 'batch_name: a number or a title', field: 'batch' });
      batch = batchByName(epic.id, b.batch_name);
      if (batch == null) return reply.code(404).send({ error: `${epic.key} has no batch ${b.batch_name}`, field: 'batch' });
    } else if (b.batch !== null && b.batch !== undefined) {
      if (!Number.isInteger(b.batch)) return reply.code(400).send({ error: 'batch: the id of a batch, or null', field: 'batch' });
      batch = b.batch;
    } else if (b.batch === undefined) return reply.code(400).send({ error: 'batch: the id of a batch, or null — or batch_name', field: 'batch' });
    let before = null;
    if (b.before !== undefined && b.before !== null) {
      if (typeof b.before !== 'string' && typeof b.before !== 'number') return reply.code(400).send({ error: 'before: the key of the task to stand before', field: 'before' });
      const t = resolveTask(String(b.before));
      if (!t) return reply.code(404).send({ error: 'the task to stand before was not found', field: 'before' });
      before = t.id;
    }
    const was = epicOf(task.id);
    const err = placeTask(epic, task, batch, before);
    if (err) return reply.code(err.code).send({ error: err.error, field: err.field });
    emit('task.linked', { id: epic.id, key: epic.key, linked: { [epic.id]: linkedOf(epic.id), [task.id]: linkedOf(task.id) } });
    const out = told(epic);
    if (was && was !== epic.id) { const other = resolveTask(String(was)); if (other) told(other); followEpic(was); }
    followEpic(epic.id);
    return out;
  });

  // «Start the batch»: its next portion now, the following ones as the board sees the previous portion out of work
  app.post('/api/tasks/:id/batches/:batchId/run', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const id = batchId(req, reply); if (!id) return reply;
    const problem = runProblem(req.body);
    if (problem) return reply.code(400).send(problem);
    const { code, ...out } = await runBatch(app, t, id, req.body);
    if (code >= 300) return reply.code(code).send(out);
    return { ...told(t), ...out };
  });
  app.post('/api/tasks/:id/batches/:batchId/stop', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const id = batchId(req, reply); if (!id) return reply;
    if (!stopBatch(t, id)) return reply.code(404).send({ error: 'this batch is not running' });
    return told(t);
  });

  app.put('/api/tasks/:id/plan', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const problem = planProblem(req.body?.body);
    if (problem) return reply.code(400).send({ error: problem, field: 'body' });
    const saved = savePlan(t.id, req.body.body, requestSession(req));
    if (saved.changed) emit('task.plan', { id: t.id, key: t.key, plan: { version: saved.version, at: saved.at, size: saved.size, versions_n: saved.versions_n } });
    return { key: t.key, ...saved };
  });
}
