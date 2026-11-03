import { db } from '../db.js';
import { healthView } from '../health.js';
import { healthFixTask } from '../auto-health.js';

let flight = null; // a second request while the folders are walked waits for the same walk
export default async function healthRoutes(app) {
  app.get('/api/health', () => {
    if (!flight) {
      const projects = db.prepare('SELECT slug, name, path, category FROM projects WHERE archived = 0 ORDER BY position, name COLLATE NOCASE').all();
      flight = healthView(projects).finally(() => { flight = null; });
    }
    return flight;
  });
  app.post('/api/health/fix', async (req, reply) => {
    const slug = req.body?.project;
    if (typeof slug !== 'string' || !slug) return reply.code(400).send({ error: 'project: a slug', field: 'project' });
    const r = await healthFixTask(app, slug);
    if (r.code) { const { code, ...body } = r; return reply.code(code).send(body); }
    return r;
  });
}
