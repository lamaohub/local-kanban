import { resolveTask, taskWords } from './tasks.js';
import { taskChanges } from '../task-changes.js';
import { attemptOf, attemptsOf, newAttempt, takeAttempt } from '../attempts.js';
import { baseOf } from '../task-branch.js';
import { resolveProject } from './projects.js';
import { execFile } from 'node:child_process';
import { bin } from '../bin-path.js';
import { branchView, openPr } from '../task-branch.js';
import { mirrorName } from '../shipped.js';
import { emit } from '../bus.js';
import { taskEvent } from '../task-shape.js';
import { db, ghOwner, ghRepo, logError } from '../db.js';

export default async function branchRoutes(app) {
  const taskOr404 = (req, reply) => {
    const t = resolveTask(req.params.id);
    if (!t) reply.code(404).send({ error: 'task not found' });
    return t;
  };
  app.get('/api/tasks/:id/branch', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    return (await branchView(t)) || { branch: null };
  });
  app.get('/api/tasks/:id/changes', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const folder = db.prepare('SELECT path FROM projects WHERE id = ?').get(t.project_id)?.path;
    const { words, known } = folder ? await taskWords(t, folder) : { words: [t.key], known: null };
    const n = req.query.attempt === undefined ? null : Number(req.query.attempt);
    if (n !== null) {
      const a = Number.isInteger(n) ? attemptOf(t, n) : null;
      if (!a) return reply.code(404).send({ error: 'no such attempt', field: 'attempt' });
      return taskChanges(t, { words, known, copy: a });
    }
    return taskChanges(t, { words, known });
  });
  const ahead = (cwd, ref) => new Promise((done) => execFile(bin('git'), ['-C', cwd, 'rev-list', '--count', `${ref}..HEAD`], { timeout: 10_000 }, (err, out) => done(err ? null : Number(String(out).trim()))));
  app.get('/api/tasks/:id/attempts', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const list = attemptsOf(t);
    for (const a of list) { const b = await baseOf(a.path, a.base); a.ahead = b ? await ahead(a.path, b.ref) : null; a.base = b?.name || null; }
    return { attempts: list };
  });
  app.post('/api/tasks/:id/attempts', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const profile = req.body?.profile ?? null;
    if (profile !== null && !Number.isInteger(profile)) return reply.code(400).send({ error: 'profile: the id of a launch profile, or null', field: 'profile' });
    const r = await newAttempt(resolveProject(t.project), t, profile);
    if (r.error) return reply.code(r.reason === 'profile' ? 400 : 409).send(r);
    return reply.code(201).send(r);
  });
  app.post('/api/tasks/:id/attempts/:n/take', (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const a = takeAttempt(t, Number(req.params.n));
    if (!a) return reply.code(404).send({ error: 'no such attempt' });
    emit('task.updated', taskEvent(t.id));
    return { n: a.n, branch: a.branch, path: a.path };
  });
  app.post('/api/tasks/:id/pr', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const r = await openPr(t, { mirror: mirrorName(ghOwner(), ghRepo()) || null });
    if (r.error) {
      if (['push', 'gh'].includes(r.reason)) logError('server', 'POST /api/tasks/:id/pr', r.error, t.key);
      return reply.code(409).send(r);
    }
    return r; // a new request goes out as task.updated from keepPr (task-branch.js): the cards and the list show it
  });
}
