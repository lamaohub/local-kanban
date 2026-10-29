import { emit } from '../bus.js';
import { currentLimits, takeReading } from '../claude-limits.js';
import { askFate, createAsk, decide, pendingAsks, STARTED_AT, waitAsk } from '../claude-asks.js';
import { changeHooks, claudeSetup, statusLineLink } from '../claude-setup.js';

/* Who may answer Claude: a request that carries the browser's marks of the board's own page — an Origin (the
   origin guard has already checked it is the board's) and, when the browser sends one, `Sec-Fetch-Site:
   same-origin`. Browsers send Sec-Fetch-* only to https and to localhost, so a board opened by a LAN address
   over plain http has none, and an Origin alone has to do.

   What this keeps out is web pages: a page of another site can neither drop its Origin nor forge these
   headers. It does NOT keep out programs on this computer — anything that reaches the board's port can send
   the same headers, list the waiting requests (GET /api/asks) and answer them. That includes Claude itself
   when it may run network commands without asking (curl allowed in the permission rules): a helper agent
   running alongside could answer the request its session is waiting on. The answers given here are only as
   strong as that: with the board connected, do not allow Claude unasked network commands to the board. */
export function fromBoardPage(req) {
  const site = req.headers['sec-fetch-site'];
  return typeof req.headers.origin === 'string' && req.headers.origin !== '' && (site === undefined || site === 'same-origin');
}

export default async function claudeRoutes(app) {
  // the footer prints the time of the last reading to the minute: the page is told when a figure moved,
  // or when that minute changed — not on every status line run (Claude Code runs it after each message)
  let toldMinute = null;

  app.post('/api/limits', (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'a JSON object with rate_limits' });
    const { snapshot, changed, ignored } = takeReading(body);
    if (ignored) return { stored: false };
    const minute = String(snapshot.at).slice(0, 16);
    if (changed || minute !== toldMinute) {
      toldMinute = minute;
      emit('limits.updated', currentLimits());
    }
    return { stored: true };
  });

  // to do about it. The event of a reading does not carry it (a reading that arrives is itself the answer, and the page
  // keeps the last `link`); the event of connecting and taking off does
  app.get('/api/limits', () => ({ ...currentLimits(), link: statusLineLink() }));

  // the hook hands a request over; `{id: null}` — the session has no task on the board, the hook steps aside
  app.post('/api/asks', (req, reply) => {
    const a = createAsk(req.body);
    if (a === null) return { id: null };
    if (a.error) return reply.code(400).send({ error: a.error });
    return reply.code(201).send(a);
  });

  // the hook waits for the answer: one long poll, then it asks again
  // (the end of the response, not of its socket: the hook's polls share one kept-alive connection)
  app.get('/api/asks/:id/wait', async (req, reply) => {
    const r = await waitAsk(String(req.params.id), { onClose: (fn) => reply.raw.once('close', fn) });
    return r.decision ? { decision: r.decision } : r.gone ? { gone: true } : { pending: true };
  });

  app.get('/api/asks', () => pendingAsks());

  app.get('/api/asks/:id', (req, reply) => {
    const fate = askFate(String(req.params.id));
    if (!fate) return reply.code(404).send({ error: 'no such request — the board was restarted since, or it ended long ago', reason: 'unknown', started_at: STARTED_AT });
    return fate;
  });

  // answer: the page draws the section from it and nothing else. Only looks: starts nothing, sends nothing out.
  app.get('/api/claude', () => claudeSetup());

  // install|uninstall` makes, agreed to on the page: `seen` is the fingerprint of the settings.json the change was
  // shown for. From the board's page only, like an answer to Claude: it changes how every Claude Code session runs.
  const hooks = (action) => (req, reply) => {
    if (!fromBoardPage(req)) return reply.code(403).send({ error: 'the board is connected to Claude Code from its own page only' });
    const seen = req.body && typeof req.body === 'object' ? req.body.seen : undefined;
    if (typeof seen !== 'string') return reply.code(400).send({ error: 'seen: the fingerprint of the settings.json the change was shown for' });
    const r = changeHooks(action, seen);
    if (r.error) return reply.code(r.status).send({ error: r.error, reason: r.reason });
    if (r.written) emit('limits.updated', { ...currentLimits(), link: statusLineLink() });
    return r;
  };
  app.put('/api/claude/hooks', hooks('install'));
  app.delete('/api/claude/hooks', hooks('uninstall'));

  app.post('/api/asks/:id/decision', (req, reply) => {
    if (!fromBoardPage(req)) return reply.code(403).send({ error: 'answers to Claude are given on the board page only' });
    const r = decide(String(req.params.id), req.body || {});
    if (r.error) return reply.code(r.status).send({ error: r.error, ...(r.reason ? { reason: r.reason } : {}), ...(r.started_at ? { started_at: r.started_at } : {}) });
    return { ok: true };
  });
}
