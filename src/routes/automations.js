import { existsSync } from 'node:fs';
import { resolveProject } from './projects.js';
import { announce, armRule, automationsView, awaySummary, dropRule, extrasProblem, ruleProblem, setAutomationsOn, setExtras } from '../automations.js';
import { nowRuns } from '../claude-now.js';
import { scalarQuery } from '../query-params.js';

/** The latest moment a Date holds, in milliseconds (ECMAScript: ±8.64e15). */
const MAX_TIME_MS = 8.64e15;

export default async function automationRoutes(app) {
  app.get('/api/automations', () => automationsView());

  app.put('/api/automations/switch', (req, reply) => {
    const on = req.body?.on;
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on: true or false' });
    setAutomationsOn(on);
    announce(true);
    return automationsView();
  });

  app.get('/api/automations/summary', async (req, reply) => {
    const q = scalarQuery(req.query, ['since']);
    if (q.error) return reply.code(400).send({ error: q.error });
    const since = Number(q.values.since);
    // past 8.64e15 ms a Date is no time at all, and toISOString threw — a 500 instead of a 400
    if (!Number.isFinite(since) || since <= 0 || since > MAX_TIME_MS) return reply.code(400).send({ error: 'since: a moment in milliseconds' });
    return awaySummary(since, (await nowRuns()).runs);
  });

  app.put('/api/automations/extras', (req, reply) => {
    const problem = extrasProblem(req.body);
    if (problem) return reply.code(400).send({ error: problem });
    setExtras(req.body);
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
