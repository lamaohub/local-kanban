import { db, uiLang } from '../db.js';
import { PORT } from '../config.js';
import { scalarQuery } from '../query-params.js';
import { cleanupTasks, knownStand, standDiff, standsView } from '../stands.js';
import { healthView } from '../health.js';
import { healthFixTask, openFixes } from '../auto-health.js';

let flight = null; // a second request while the folders are walked waits for the same walk
export default async function healthRoutes(app) {
  app.get('/api/health', () => {
    if (!flight) {
      const projects = db.prepare('SELECT slug, name, path, category FROM projects WHERE archived = 0 ORDER BY position, name COLLATE NOCASE').all();
      flight = healthView(projects).finally(() => { flight = null; });
    }
    return flight;
  });
  app.get('/api/health/stands', (req, reply) => {
    const q = scalarQuery(req.query, ['refresh']);
    if (q.error) return reply.code(400).send({ error: q.error });
    return standsView({ force: q.values.refresh === '1' });
  });
  // what of a stand is not in main — only a folder of the last walk, never a path the request makes up
  app.get('/api/health/stands/diff', async (req, reply) => {
    const q = scalarQuery(req.query, ['path']);
    if (q.error) return reply.code(400).send({ error: q.error });
    if (!q.values.path || !knownStand(q.values.path)) return reply.code(404).send({ error: 'no such stand in the last look', field: 'path' });
    return standDiff(q.values.path);
  });
  // the task of the cleanup — one per repository; the page then starts each as «Fix» does
  app.post('/api/health/stands/task', async (req, reply) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string')) return reply.code(400).send({ error: 'paths: a list of folders', field: 'paths' });
    const r = await cleanupTasks(app, paths, uiLang() === 'en' ? 'en' : 'ru', { host: `127.0.0.1:${PORT}` });
    if (r.code) { const { code, ...body } = r; return reply.code(code).send(body); }
    return r;
  });
  app.get('/api/health/fixes', () => ({ fixes: openFixes() }));
  app.post('/api/health/fix', async (req, reply) => {
    const slug = req.body?.project;
    if (typeof slug !== 'string' || !slug) return reply.code(400).send({ error: 'project: a slug', field: 'project' });
    const r = await healthFixTask(app, slug);
    if (r.code) { const { code, ...body } = r; return reply.code(code).send(body); }
    return r;
  });
}
