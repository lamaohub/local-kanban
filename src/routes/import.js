import { importVibe, IMPORT_MAX } from '../import-vibe.js';
import { scalarQuery } from '../query-params.js';
import { logError } from '../db.js';

export default async function importRoutes(app) {
  app.register(async (scope) => {
    scope.addContentTypeParser(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: IMPORT_MAX }, (req, body, done) => done(null, body));
    scope.post('/api/import/vibe-kanban', async (req, reply) => {
      const q = scalarQuery(req.query, ['dry']);
      if (q.error) return reply.code(400).send({ error: q.error });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'the body is the zip of the export: Content-Type application/zip', reason: 'no-archive' });
      try {
        return importVibe(req.body, { dry: q.values.dry === '1' });
      } catch (e) {
        if (e.statusCode === 400) return reply.code(400).send({ error: e.message, reason: 'not-vibe' });
        logError('server', 'POST /api/import/vibe-kanban', `import failed: ${e.message}`);
        throw e;
      }
    });
  });
}
