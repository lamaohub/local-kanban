import { emit } from '../bus.js';
import { isPreviewBoard } from '../config.js';
import { isGuest, setShare, shareState } from '../share.js';
import { fromBoardPage } from './claude.js';

export default async function shareRoutes(app) {
  app.get('/api/share', (req) => (isGuest(req) ? { guest: true, on: true } : shareState()));

  const ownerOnly = (req, reply) => {
    if (isGuest(req)) return reply.code(403).send({ error: 'only the owner of the board opens and closes it to the network', reason: 'guest' });
    if (!fromBoardPage(req)) return reply.code(403).send({ error: 'only from the board page', reason: 'not-page' });
    if (isPreviewBoard()) return reply.code(403).send({ error: 'this is a check board opened from a backup — it does not open to the network', reason: 'preview' });
    return null;
  };

  app.put('/api/share', async (req, reply) => {
    if (ownerOnly(req, reply)) return reply;
    const on = req.body?.on;
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on: true or false' });
    const st = await setShare(on);
    emit('share.updated', { on: st.on });
    return st;
  });
}
