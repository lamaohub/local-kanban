import { bus, SSE_MAX } from '../bus.js';
import { isGuest } from '../share.js';

let sseClients = 0;
export const sseCount = () => sseClients;

export const GUEST_SSE_MAX = 5;
const guestMax = () => Math.max(0, Math.min(GUEST_SSE_MAX, SSE_MAX - 1));
let guestClients = 0;
export const guestCount = () => guestClients;
/** Why a new stream of this request would be refused: 'guests' — the guests' share is taken, 'full', or null. */
function refusal(req) {
  if (sseClients >= SSE_MAX) return 'full';
  if (isGuest(req) && guestClients >= guestMax()) return 'guests';
  return null;
}

const SSE_BUFFER_MAX = 4 * 1024 * 1024;
let bufferMax = SSE_BUFFER_MAX;
/** Tests lower the limit, so that a stuck client is found without megabytes of events. */
export function setSseBufferMax(n) { bufferMax = n > 0 ? n : SSE_BUFFER_MAX; }

const SSE_TOTAL_MAX = 12 * 1024 * 1024;
let totalMax = SSE_TOTAL_MAX;
/** Tests lower the limit of all the streams together. */
export function setSseTotalMax(n) { totalMax = n > 0 ? n : SSE_TOTAL_MAX; }
const streams = new Set();
function dropWorst() {
  let sum = 0;
  let worst = null;
  for (const raw of streams) {
    sum += raw.writableLength;
    if (!worst || raw.writableLength > worst.writableLength) worst = raw;
  }
  if (sum > totalMax && worst) worst.destroy();
}
// one event goes to every stream: it is turned into text once, not once per stream
let lastEvent = null;
let lastText = '';
const textOf = (ev) => {
  if (ev !== lastEvent) { lastEvent = ev; lastText = `data: ${JSON.stringify(ev)}\n\n`; }
  return lastText;
};

export default async function eventRoutes(app) {
  app.get('/api/events/room', (req) => {
    const why = refusal(req);
    return { full: Boolean(why), reason: why };
  });

  app.get('/api/events', (req, reply) => {
    const why = refusal(req);
    if (why) return reply.code(503).send({ error: why === 'guests' ? 'the places of guests for live updates are taken' : 'too many SSE connections', reason: why });
    const guest = isGuest(req);
    sseClients++;
    if (guest) guestClients++;
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('\n');

    const send = (ev) => {
      if (reply.raw.destroyed) return;
      if (reply.raw.writableLength > bufferMax) { reply.raw.destroy(); return; }
      reply.raw.write(textOf(ev));
      if (reply.raw.writableLength) dropWorst();
    };
    bus.on('event', send);

    const heartbeat = setInterval(() => send({ type: 'ping' }), 30000);

    req.raw.on('close', () => {
      sseClients--;
      if (guest) guestClients--;
      streams.delete(reply.raw);
      clearInterval(heartbeat);
      bus.off('event', send);
    });
  });
}
