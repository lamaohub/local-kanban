import { bus, SSE_MAX } from '../bus.js';

let sseClients = 0;
export const sseCount = () => sseClients;

export default async function eventRoutes(app) {
  app.get('/api/events', (req, reply) => {
    if (sseClients >= SSE_MAX) return reply.code(503).send({ error: 'too many SSE connections' });
    sseClients++;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('\n');

    const onEvent = (ev) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    bus.on('event', onEvent);

    const heartbeat = setInterval(() => reply.raw.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`), 30000);

    req.raw.on('close', () => {
      sseClients--;
      clearInterval(heartbeat);
      bus.off('event', onEvent);
    });
  });
}
