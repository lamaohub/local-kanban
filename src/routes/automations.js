import { existsSync } from 'node:fs';
import { resolveProject } from './projects.js';
import { announce, armRule, automationsView, dropRule, ruleProblem, setAutomationsOn } from '../automations.js';

export default async function automationRoutes(app) {
  app.get('/api/automations', () => automationsView());

  app.put('/api/automations/switch', (req, reply) => {
    const on = req.body?.on;
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on: true or false' });
    setAutomationsOn(on);
    announce(true);
    return automationsView();
  });

  app.post('/api/automations', (req, reply) => {
    const b = req.body;
    const problem = ruleProblem(b);
    if (problem) return reply.code(400).send({ error: problem });
    const p = resolveProject(b.project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (p.archived) return reply.code(400).send({ error: 'the project is archived' });
    // the check starts inside the board, in the project's folder: said now, not after the batch and the pause (review)
    if (!p.path || !existsSync(p.path)) return reply.code(409).send({ error: 'the project has no folder on this computer — set it in the project', reason: 'no-folder' });
    const r = armRule(p, b);
    if (r.error) { const { code, ...body } = r; return reply.code(code).send(body); }
    announce(true);
    return reply.code(201).send({ id: r.id, ...automationsView() });
  });

  app.delete('/api/automations/:automationId', (req, reply) => {
    const id = Number(req.params.automationId);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'automationId: a number' });
    if (!dropRule(id)) return reply.code(404).send({ error: 'automation not found' });
    announce(true);
    return automationsView();
  });
}
