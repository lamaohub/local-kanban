import { createHash } from 'node:crypto';
import { resolveTask } from './tasks.js';
import { sayToTerminal } from '../terminal-say.js';
import { typing } from '../chat-queue.js';
import { COLS_MAX, COLS_MIN, KEYS, REPLY_MAX, noteLook, phantomMessage, phantomResize, phantomStop, questionOpen, taskTerminal, widthFor } from '../phantom.js';
import { logError } from '../db.js';
import { scalarQuery } from '../query-params.js';

export default async function terminalRoutes(app) {
  const taskOr404 = (req, reply) => {
    const t = resolveTask(req.params.id);
    if (!t) reply.code(404).send({ error: 'task not found' });
    return t;
  };

  app.get('/api/tasks/:id/terminal', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const q = scalarQuery(req.query, ['cols', 'seen']);
    if (q.error) return reply.code(400).send({ error: q.error });
    const cols = q.values.cols === undefined ? null : Number(q.values.cols);
    if (cols !== null && !(Number.isInteger(cols) && cols >= COLS_MIN && cols <= COLS_MAX)) {
      return reply.code(400).send({ error: `cols: a whole number from ${COLS_MIN} to ${COLS_MAX}` });
    }
    const term = await taskTerminal(t.id, { screen: true });
    if (!term) return { session: null };
    noteLook(term.session);
    // a Claude that has exited cannot redraw itself: its last screen stays as it was laid out. A column or two
    // wider is not worth a redraw: the same card measures 46 in Chromium and 45 in Safari, and two of them
    // open at once would otherwise lay the window out again every second, one after the other (review)
    const want = cols === null ? null : widthFor(term.session, cols);
    const lay = want !== null && !term.dead && (term.cols === null || want < term.cols || want > term.cols + 2);
    if (lay && !(await phantomResize(term.session, want)).err) term.cols = want;
    // whether Claude waits on an open question (a permission, the trust of a folder, a choice): «Claude review» says
    term.question = !term.dead && questionOpen(term.screen);
    // a second, 9 answers out of 9 the same byte for byte. Now an answer the card already has is `same`
    const v = createHash('sha1').update(JSON.stringify(term)).digest('hex').slice(0, 20);
    if (q.values.seen === v) return { same: true, v };
    return { ...term, v };
  });

  app.post('/api/tasks/:id/terminal', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const { text, key } = req.body || {};
    if (text !== undefined && (typeof text !== 'string' || text.length > REPLY_MAX || text.includes('\0'))) {
      return reply.code(400).send({ error: `text: at most ${REPLY_MAX} characters, no NUL` });
    }
    if (key !== undefined && !KEYS.has(key)) return reply.code(400).send({ error: `key: one of ${[...KEYS].join(', ')}` });
    if (!text && !key) return reply.code(400).send({ error: 'text or key' });
    const term = await taskTerminal(t.id);
    if (!term) return reply.code(404).send({ error: 'no Claude of the board works on this task' });
    if (term.dead) return reply.code(409).send({ error: 'Claude has exited in this terminal' });
    const r = await typing(term.session, () => sayToTerminal(t, term.session, { text, key }));
    if (r.err) {
      logError('server', 'terminal', `typing into the terminal failed: ${r.err.message}`, r.text);
      return reply.code(500).send({ error: r.text || r.err.message });
    }
    return r;
  });

  // (src/phantom.js, phantomMessage); 409 with `reason` — question, busy, gone — and nothing typed
  app.post('/api/tasks/:id/terminal/message', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > REPLY_MAX || text.includes('\0')) {
      return reply.code(400).send({ error: `text: a message of at most ${REPLY_MAX} characters, no NUL` });
    }
    const term = await taskTerminal(t.id);
    if (!term) return reply.code(404).send({ error: 'no Claude of the board works on this task', reason: 'gone' });
    const r = await phantomMessage(term.session, t.key, text.trim());
    if (r.refused) {
      const why = { question: 'Claude is asking a question in its terminal', busy: 'Claude is in the middle of its work', gone: 'Claude has exited in this terminal' };
      return reply.code(409).send({ error: why[r.refused], reason: r.refused, typed: Boolean(r.typed) });
    }
    if (r.err) {
      logError('server', 'terminal', `a message to the terminal failed: ${r.err.message}`, r.text);
      return reply.code(500).send({ error: r.text || r.err.message });
    }
    return { ok: true, session: term.session };
  });

  app.delete('/api/tasks/:id/terminal', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const term = await taskTerminal(t.id);
    if (!term) return reply.code(404).send({ error: 'no Claude of the board works on this task' });
    await phantomStop(term.session);
    return { ok: true, session: term.session };
  });
}
