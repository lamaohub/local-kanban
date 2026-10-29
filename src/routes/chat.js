
import { resolveTask, taskAttachmentPaths } from './tasks.js';
import { REPLY_MAX, claudeAtPrompt, phantomScreen, phantomSend, taskTerminal } from '../phantom.js';
import { SESSION_ID_RE, taskSessions, transcriptNow } from '../claude-sessions.js';
import { PICTURE_MAX, PICTURE_TYPES, SHOT_RE, TURNS_DEFAULT, TURNS_MAX, chatHash, chatPicture, chatShot, pictureKindOf, saidCommand, transcriptChat, watchChat } from '../chat-feed.js';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { enqueue, enqueueFirst, markSaid, queued, saidLately, takeQueued, typing, unqueue } from '../chat-queue.js';
import { sayToTerminal } from '../terminal-say.js';
import { emit } from '../bus.js';
import { db, logError } from '../db.js';
import { scalarQuery } from '../query-params.js';
import { boardPaneEnded, readRegistry, stateOf } from '../claude-live.js';
import { waitsOwnWork } from '../own-wait.js';
import { commandSpec, launchOptions, runLaunch } from '../launch.js';
import { launchDryRun } from '../config.js';
import { fromBoardPage } from './claude.js';
import { existsSync } from 'node:fs';
import { plainScreen, wholeChoice } from '../question-screen.js';

/** What the screen shows of an open question: its last QUESTION_LINES lines with words, the input box below them left out. */
const QUESTION_LINES = 16;
const QUESTION_HISTORY = 200; // rows of the history over the window a question is read from (screenQuestion's ABOVE_MAX)
export function questionLines(screen) {
  const lines = String(screen).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.slice(-QUESTION_LINES).join('\n').replace(/^\n+/, '');
}

let registryRead = { at: 0, p: null };
const REGISTRY_FRESH_MS = 2000;
function registry() {
  if (!registryRead.p || Date.now() - registryRead.at > REGISTRY_FRESH_MS) {
    registryRead = { at: Date.now(), p: readRegistry().catch(() => new Map()) };
  }
  return registryRead.p;
}

/** Tests: the registry is read anew on the next look. */
export const forgetRegistry = () => { registryRead = { at: 0, p: null }; };

/** The session a chat shows: the one asked for, if it is the task's; else the newest one with a transcript. */
export function pickSession(sessions, asked) {
  if (asked) return sessions.find((s) => s.session_id === asked) || null;
  const byLast = [...sessions].sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  return byLast.find((s) => s.transcript) || byLast[0] || null;
}

export const CHAT_IMAGES_MAX = 10; // pictures in one message
export const RUN_MAX = 8000;
export { PICTURE_MAX };
const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export const STOP_GAP_MS = 1500;
const stoppedAt = new Map(); // session → when Esc went to it last

export const NOT_DELIVERED = {
  'no-box': "Claude's input field is not on its screen — nothing was typed",
  'not-typed': "the words did not show in Claude's input field — not sent",
  'not-sent': "the words are in Claude's input field, but Enter did not send them — press Enter in the terminal",
};

/** {status, body} of words typed now. */
async function sayNow(t, session, text, images) {
  const r = await typing(session, async () => {
    const st = await claudeAtPrompt(session);
    if (st === 'question' || st === 'gone') return { refused: st };
    markSaid(session);
    const said = await sayToTerminal(t, session, { text, key: 'Enter', chat: true, images });
    markSaid(session); // the next words wait from the END of these: typing them may take longer than QUEUE_IDLE_MS
    return said;
  });
  if (r.refused === 'question') return { status: 409, body: { error: 'Claude asks a question — answer it first', reason: 'question' } };
  if (r.refused === 'gone') return { status: 409, body: { error: 'no Claude of the board works on this task — the chat can only be read', reason: 'gone' } };
  if (r.refused) return { status: 409, body: { error: NOT_DELIVERED[r.refused], reason: r.refused } };
  if (r.err) {
    logError('server', 'chat', `typing a chat message failed: ${r.err.message}`, r.text);
    return { status: 500, body: { error: r.text || r.err.message } };
  }
  emit('session.chat', { session });
  return { status: 200, body: { sent: true, now: true, session, prep: r.prep, doing: r.doing } };
}

export default async function chatRoutes(app) {
  const taskOr404 = (req, reply) => {
    const t = resolveTask(req.params.id);
    if (!t) reply.code(404).send({ error: 'task not found' });
    return t;
  };

  app.get('/api/tasks/:id/chat', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const q = scalarQuery(req.query, ['session', 'turns', 'seen']);
    if (q.error) return reply.code(400).send({ error: q.error });
    const { session: asked, seen } = q.values;
    if (asked !== undefined && !SESSION_ID_RE.test(asked)) return reply.code(400).send({ error: 'session: a session id' });
    const turns = q.values.turns === undefined ? TURNS_DEFAULT : Number(q.values.turns);
    if (!(Number.isInteger(turns) && turns >= 1 && turns <= TURNS_MAX)) return reply.code(400).send({ error: `turns: a whole number from 1 to ${TURNS_MAX}` });
    const sessions = await taskSessions(t.id);
    const s = pickSession(sessions, asked);
    if (asked && !s) return reply.code(404).send({ error: 'no such session of this task' });
    const list = sessions.map((x) => ({ session_id: x.session_id, last_seen: x.last_seen, transcript: Boolean(x.transcript) }));
    if (!s) return { session: null, sessions: list, turns: [], earlier_n: 0, queue: [], send: false, state: null };
    if (!s.transcript) s.transcript = await transcriptNow(t.id, s.session_id);
    const chat = await transcriptChat(s.transcript, { turns });
    watchChat(s.transcript, s.session_id);
    // the chat talks only to the board's Claude of this task, and only in the session it shows
    const term = await taskTerminal(t.id);
    const send = Boolean(term && !term.unknown && !term.dead && term.session === s.session_id);
    const state = send ? await claudeAtPrompt(s.session_id) : null;
    // terminal beside it must answer Claude's question itself: what the screen shows of it, and keys under it
    const screen = state === 'question' ? (await phantomScreen(s.session_id, 0, { escapes: true })) ?? '' : null;
    const question = screen === null ? null : questionLines(plainScreen(screen));
    const choice = screen === null ? null : await wholeChoice(screen, () => phantomScreen(s.session_id, QUESTION_HISTORY, { escapes: true }));
    const regState = stateOf((await registry()).get(s.session_id));
    const working = ['busy', 'background'].includes(regState);
    // the person, with commands left running: the page says which. Only for a turn over (a turn going on is «working»
    // whatever runs), from the transcript the chat read
    const own = working && chat.turns.length > 0 && !chat.turns.at(-1).open && await waitsOwnWork(s.session_id, Date.now(), s.transcript);
    // and does not say «not inside the board»
    const ownTerm = term && !term.unknown && term.session === s.session_id;
    let ended = ownTerm && term.dead ? { exit: term.exit ?? null, interrupted: Boolean(term.interrupted) } : null;
    // Claude not alive anywhere (a `claude --resume` the person ran in the Terminal is), and its conversation on disk.
    // Not while another Claude of the board works on the task (an older session picked in the chat): a second one on it
    const free = !term || (term.dead && !ownTerm);
    if (!ended && free && regState === 'gone') ended = await boardPaneEnded(s.session_id);
    // (it exited with them, or they went back to its field)
    if (!working) chat.waiting = [];
    const body = { session: s.session_id, sessions: list, ...chat, queue: queued(s.session_id), send, state, working, own, ...(question ? { question } : {}), ...(choice ? { choice } : {}), ...(ended ? { ended } : {}) };
    const v = chatHash(body);
    if (seen === v) return { same: true, v };
    return { ...body, v };
  });

  /** The type of a picture by its first bytes (PNG, JPEG, GIF, WebP), null for anything else. */
  async function pictureKind(path) {
    const head = Buffer.alloc(12);
    let fh;
    try { fh = await open(path, 'r'); await fh.read(head, 0, 12, 0); } catch { return null; } finally { await fh?.close(); }
    return pictureKindOf(head);
  }
  /** The transcript of the session a picture route asks about (`?session=`, the task's), or null — the answer sent. */
  async function pictureSession(req, reply, t, badParam) {
    const q = scalarQuery(req.query, ['session']);
    if (q.error) { reply.code(400).send({ error: q.error }); return null; }
    const asked = q.values.session;
    if (asked !== undefined && !SESSION_ID_RE.test(asked)) { reply.code(400).send({ error: 'session: a session id' }); return null; }
    if (badParam) { reply.code(400).send({ error: badParam }); return null; }
    const s = pickSession(await taskSessions(t.id), asked);
    if (!s) { reply.code(404).send({ error: 'no such session of this task' }); return null; }
    if (!s.transcript) s.transcript = await transcriptNow(t.id, s.session_id);
    return s;
  }
  app.get('/api/tasks/:id/chat/picture/:toolId', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const s = await pictureSession(req, reply, t, TOOL_ID_RE.test(req.params.toolId) ? null : 'toolId: the id of a step');
    if (!s) return reply;
    const path = await chatPicture(s.transcript, req.params.toolId);
    if (!path) return reply.code(404).send({ error: 'no picture read in this step' });
    // link «shot.png → /etc/passwd» that a Read had read was served whole, and so was a file put in its place after
    let real;
    let st;
    try { real = await realpath(path); st = await stat(real); } catch { return reply.code(404).send({ error: 'the picture is no longer there' }); }
    if (!st.isFile()) return reply.code(404).send({ error: 'the picture is no longer there' });
    if (st.size > PICTURE_MAX) return reply.code(413).send({ error: 'the picture is too large to show' });
    const type = PICTURE_TYPES[real.split('.').pop().toLowerCase()];
    if (!type || type !== await pictureKind(real)) return reply.code(404).send({ error: 'no picture read in this step' });
    return reply.type(type).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=300')
      .header('Content-Length', st.size).send(createReadStream(real));
  });

  app.get('/api/tasks/:id/chat/image/:ref', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const s = await pictureSession(req, reply, t, SHOT_RE.test(req.params.ref) ? null : 'ref: a picture of the chat');
    if (!s) return reply;
    const shot = await chatShot(s.transcript, req.params.ref);
    if (!shot) return reply.code(404).send({ error: 'no such picture in this chat' });
    return reply.type(shot.type).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=300')
      .send(shot.data);
  });

  app.post('/api/tasks/:id/chat/run', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    if (!fromBoardPage(req)) return reply.code(403).send({ error: 'a command is run only from the board\'s page' });
    const b = req.body || {};
    if (typeof b.session !== 'string' || !SESSION_ID_RE.test(b.session)) return reply.code(400).send({ error: 'session: a session id' });
    if (typeof b.code !== 'string' || !b.code.trim() || b.code.length > RUN_MAX || b.code.includes('\0')) {
      return reply.code(400).send({ error: `code: the command, at most ${RUN_MAX} characters` });
    }
    const s = (await taskSessions(t.id)).find((x) => x.session_id === b.session);
    if (!s) return reply.code(404).send({ error: 'no such session of this task' });
    if (!s.transcript) s.transcript = await transcriptNow(t.id, s.session_id);
    const lang = await saidCommand(s.transcript, b.code);
    if (lang === null) {
      return reply.code(409).send({ error: 'Claude did not write this command in this chat — nothing was run', reason: 'not-said' });
    }
    if (!launchDryRun() && !launchOptions().terminal) {
      return reply.code(409).send({ error: 'no terminal to open on this computer — copy the command instead', reason: 'no-terminal' });
    }
    // review: the person said yes to a command «in the project folder» — without one it would run in the home folder (as
    const folder = db.prepare('SELECT path FROM projects WHERE id = ?').get(t.project_id)?.path;
    if (!folder || !existsSync(folder)) {
      return reply.code(409).send({ error: 'the project has no folder on this computer — the command would run in the home folder; copy it instead', reason: 'no-folder' });
    }
    let spec;
    try { spec = commandSpec({ code: b.code, folder, lang }); } catch (e) { return reply.code(e.statusCode || 500).send({ error: e.message }); }
    if (launchDryRun()) return { ok: true, dry: true, folder, ...spec };
    const res = await runLaunch(spec);
    if (res.err) {
      logError('server', 'chat', `running a command of the chat failed: ${res.err.message}`, res.text);
      return reply.code(500).send({ error: 'the terminal did not open — copy the command instead' });
    }
    return { ok: true, folder };
  });

  app.post('/api/tasks/:id/chat', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const text = req.body?.text ?? '';
    const ids = req.body?.images ?? [];
    if (!Array.isArray(ids) || ids.length > CHAT_IMAGES_MAX || !ids.every((x) => Number.isInteger(x) && x > 0) || new Set(ids).size !== ids.length) {
      return reply.code(400).send({ error: `images: at most ${CHAT_IMAGES_MAX} different ids of this task's attachments` });
    }
    if (typeof text !== 'string' || (!text.trim() && !ids.length) || text.length > REPLY_MAX || text.includes('\0')) {
      return reply.code(400).send({ error: `text: a message of at most ${REPLY_MAX} characters, no NUL` });
    }
    const images = taskAttachmentPaths(t.id, ids);
    if (!images) return reply.code(400).send({ error: 'images: an attachment of this task only' });
    const term = await taskTerminal(t.id);
    if (!term || term.unknown || term.dead) {
      return reply.code(409).send({ error: 'no Claude of the board works on this task — the chat can only be read', reason: 'gone' });
    }
    // words already waiting go first: these ones line up behind them, even if Claude is free right now; and words typed
    // a moment ago (here, in another chat, out of the queue) have not shown Claude busy yet — these ones wait too.
    if (req.body?.now !== undefined && typeof req.body.now !== 'boolean') return reply.code(400).send({ error: 'now: true or false' });
    if (req.body?.now) { const r = await sayNow(t, term.session, text, images); return reply.code(r.status).send(r.body); }
    const r = await typing(term.session, async () => {
      if (queued(term.session).length || saidLately(term.session) || (await claudeAtPrompt(term.session)) !== 'idle') return null;
      markSaid(term.session);
      const said = await sayToTerminal(t, term.session, { text, key: 'Enter', chat: true, images });
      markSaid(term.session);
      return said;
    });
    if (r) {
      if (r.refused) return reply.code(409).send({ error: NOT_DELIVERED[r.refused], reason: r.refused });
      if (r.err) {
        logError('server', 'chat', `typing a chat message failed: ${r.err.message}`, r.text);
        return reply.code(500).send({ error: r.text || r.err.message });
      }
      emit('session.chat', { session: term.session });
      return { sent: true, session: term.session, prep: r.prep, doing: r.doing };
    }
    const q = enqueue(term.session, t.id, text.trim(), images);
    if (q.full) return reply.code(409).send({ error: 'too many messages wait for this Claude already', reason: 'full' });
    return { queued: true, id: q.id, session: term.session };
  });

  app.post('/api/tasks/:id/chat/stop', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const term = await taskTerminal(t.id);
    if (!term || term.unknown || term.dead) {
      return reply.code(409).send({ error: 'no Claude of the board works on this task — the chat can only be read', reason: 'gone' });
    }
    const r = await typing(term.session, async () => {
      if (Date.now() - (stoppedAt.get(term.session) || 0) < STOP_GAP_MS) return { refused: 'stopping' };
      if ((await claudeAtPrompt(term.session)) !== 'busy') return { refused: 'not-busy' };
      stoppedAt.set(term.session, Date.now());
      return phantomSend(term.session, { key: 'Escape' });
    });
    if (r.refused === 'stopping') return reply.code(409).send({ error: 'Claude is being stopped already', reason: 'stopping' });
    if (r.refused) return reply.code(409).send({ error: 'Claude is not at work — there is nothing to stop', reason: 'not-busy' });
    if (r.err) return reply.code(500).send({ error: r.text || r.err.message });
    emit('session.chat', { session: term.session });
    return { stopped: true, session: term.session };
  });

  app.post('/api/tasks/:id/chat/queue/:itemId/now', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    const term = await taskTerminal(t.id);
    if (!term || term.unknown || term.dead) {
      return reply.code(409).send({ error: 'no Claude of the board works on this task — the chat can only be read', reason: 'gone' });
    }
    const item = takeQueued(term.session, req.params.itemId);
    if (!item) return reply.code(404).send({ error: 'these words are not waiting any more — they went, or were taken back' });
    const r = await sayNow(t, term.session, item.text, item.images);
    if (r.status !== 200) enqueueFirst(term.session, item); // not typed: back to the head of the queue, not lost
    return reply.code(r.status).send(r.body);
  });

  app.delete('/api/tasks/:id/chat/queue/:itemId', async (req, reply) => {
    const t = taskOr404(req, reply); if (!t) return reply;
    for (const s of await taskSessions(t.id)) if (unqueue(s.session_id, req.params.itemId)) return { ok: true };
    return reply.code(404).send({ error: 'these words are not waiting any more — they went, or were taken back' });
  });
}
