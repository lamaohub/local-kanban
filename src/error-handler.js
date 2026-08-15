import { logError } from './db.js';

export function errorHandler(err, req, reply) {
  const code = err.statusCode || 500;
  if (code >= 500) {
    req.log.error(err);
    logError('server', `${req.method} ${req.url.split('?')[0]}`, err.message, err.stack);
    return reply.code(500).send({ error: 'internal error — details under Settings → Errors' });
  }
  return reply.send(err);
}
