
import { realpath, stat } from 'node:fs/promises';
import { db, kvGet, kvSet, logError, uiLang } from './db.js';
import { PORT } from './config.js';
import { emit } from './bus.js';
import { ADOPT_TOKEN, findTranscript } from './claude-sessions.js';
import { tailLines } from './own-wait.js';
import { nowRuns } from './claude-now.js';
import { transcriptChat } from './chat-feed.js';
import { fieldEmpty } from './phantom.js';
import { typing } from './chat-queue.js';
import { sayToTerminal } from './terminal-say.js';
import { resolveTask } from './routes/tasks.js';

export const RESUME_SWITCH = 'automations.resume';
export const RESUME_LAUNCH = 'automations.resume.launch';
const CHAINS_KEY = 'automations.resume.chains';
export const RESUME_TRIES = 3;
export const RESUME_EVERY_MS = 60_000;
const CHAIN_FORGET_MS = 3 * 3600_000; // a session that broke again this long after the last try starts a chain of its own
const WORKING = new Set(['prep', 'doing', 'deploy']);
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode']);
const own = { host: `127.0.0.1:${PORT}` };

const WORDS = {
  ru: { resumed: 'Доска продолжила прерванную сессию сама.', told: 'Лимит сброшен: доска попросила Claude продолжить.', go: 'Доска: лимит подписки сбросился. Продолжай с того места, где остановился.', goOn: 'Доска: сессия была прервана. Продолжай с того места, где остановился.' },
  en: { resumed: 'The board went on with the interrupted session by itself.', told: 'The limit has reset: the board told Claude to go on.', go: 'The board: the subscription limit has reset. Go on from where you stopped.', goOn: 'The board: the session was interrupted. Go on from where you stopped.' },
};
const say = () => WORDS[uiLang() === 'en' ? 'en' : 'ru'];

/** A line of the board in a card: what it did by itself, and why. */
export function boardNote(taskId, text) {
  const t = db.prepare(`SELECT t.id, p.prefix || '-' || t.task_no AS key, p.slug AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId);
  if (!t) return;
  const r = db.prepare("INSERT INTO task_comments (task_id, author, body) VALUES (?, 'board', ?)").run(t.id, text);
  const c = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(r.lastInsertRowid);
  const n = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(t.id).n;
  emit('task.comment', { task_id: t.id, key: t.key, project: t.project, comment: c, comments_n: n });
}

/** The keys in work of a run whose Claude is gone and may be brought back, or null. Pure. */
export function resumable(run) {
  if (!run.session || run.claude !== 'gone') return null;
  // a board session that ended by itself (/exit, not signed in) stays ended; stopped from outside or lost — goes on
  if (run.board && !(run.ended?.interrupted || run.ended?.lost)) return null;
  const keys = (run.tasks || []).filter((t) => WORKING.has(t.status)).map((t) => t.key);
  return keys.length ? keys : null;
}
/** Whether a session's chain allows one more try. `chain` — {n, at} of its last try. Pure. */
export function chainAllows(chain, now) {
  return !chain || now - chain.at > CHAIN_FORGET_MS || chain.n < RESUME_TRIES;
}
/** How a conversation stopped: `cut` — in the middle of work; `asks` — on a question to the person; `over` — its turn
    ended; `none` — no transcript. The Claude app writes no end of a turn: there, words last are a turn over (`board` — a
    session of the board, whose turns are told). Pure on the chat's answer. */
export function howItStopped(turn, board) {
  if (!turn) return 'none';
  if (!turn.open) return 'over';
  const last = turn.items?.at(-1);
  if (last?.kind === 'tool' && last.ms === undefined && ASKS_PERSON.has(last.tool)) return 'asks';
  if (!board && last?.kind === 'text') return 'over';
  return 'cut';
}

/** The folder a session worked in, by its transcript; null when it does not say. Claude Code finds a conversation by the
    folder: a session of a worktree or a subfolder cannot be brought back from the project's. */
async function sessionFolder(sid) {
  const path = await findTranscript(sid);
  const size = path ? await stat(path).then((s) => s.size, () => 0) : 0;
  const lines = size ? await tailLines(path, size, 64 * 1024).catch(() => []) : [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const d = JSON.parse(lines[i]); if (typeof d?.cwd === 'string') return d.cwd; } catch { /* a cut line */ }
  }
  return null;
}
const sameFolder = async (a, b) => { try { return (await realpath(a)) === (await realpath(b)); } catch { return false; } };

const parseLabels = (v) => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } };

let deps = {
  runs: () => nowRuns(),
  turn: async (sid) => { const path = await findTranscript(sid); return path ? (await transcriptChat(path, { turns: 1 })).turns.at(-1) : null; },
  say: (t, sid, text) => sayToTerminal(t, sid, { text, key: 'Enter' }),
  fieldEmpty: (sid) => fieldEmpty(sid),
  folder: sessionFolder,
};
/** Tests stand in for what needs a live Claude. */
export function setResumeDeps(d) { deps = { ...deps, ...d }; }

function chains(now) {
  let map = {};
  try { map = JSON.parse(kvGet(CHAINS_KEY) || '{}') || {}; } catch { /* starts anew */ }
  for (const [sid, c] of Object.entries(map)) if (now - c.at > CHAIN_FORGET_MS) delete map[sid];
  return map;
}
function noted(map, sid, now) {
  map[sid] = { n: (map[sid]?.n || 0) + 1, at: now };
  kvSet(CHAINS_KEY, JSON.stringify(map));
}

const SAY_WAIT_MS = 10 * 60_000; // a Claude brought back with no words by then, or a field that stays full: the next chain's business
const LIMIT_GRACE_MS = 2 * 60_000; // past the moment the limit line names: the line may stay on the screen after the reset
const LINE_BACK_MS = 6 * 3600_000; // a line first seen after its moment names that moment, not the same hour tomorrow
const STOPPED_KEY = 'automations.resume.stopped';
const stopped = new Map(); // sid → {key, why, at, held?}: a board Claude to be told to go on once it stands at its prompt; `held` — since when its field keeps the words out
try { for (const [sid, v] of Object.entries(JSON.parse(kvGet(STOPPED_KEY) || '{}') || {})) stopped.set(sid, v); } catch { /* starts anew */ }
const keepStopped = () => kvSet(STOPPED_KEY, JSON.stringify(Object.fromEntries(stopped)));
const forget = (sid) => { stopped.delete(sid); keepStopped(); };
let lastLook = 0;
/** Tests start clean. */
export function resetResume() { stopped.clear(); keepStopped(); lastLook = 0; }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The first moment after `since` that the limit line names («12:50am», «3pm», «Oct 9 at 10am»), local time; null when it
    cannot be read. Pure. */
export function resetAfter(words, since) {
  const m = /^(?:([a-z]{3})[a-z]* (\d{1,2}),? (?:at )?)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/i.exec(String(words ?? '').trim());
  if (!m) return null;
  const hour = m[5] ? Number(m[3]) % 12 + (m[5].toLowerCase() === 'pm' ? 12 : 0) : Number(m[3]);
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : new Date(since).getMonth();
  if (hour > 23 || month < 0) return null;
  const from = new Date(since);
  const at = (year, day) => new Date(year, month, day, hour, Number(m[4] || 0)).getTime();
  const first = at(from.getFullYear(), m[1] ? Number(m[2]) : from.getDate());
  if (first > since) return first;
  return m[1] ? at(from.getFullYear() + 1, Number(m[2])) : at(from.getFullYear(), from.getDate() + 1);
}

/** One look: at most one session goes on. `waiting` — ids of tasks a question or a request holds; `limited` — the
    subscription is used up now. */
export async function tickResume(app, now, { waiting = new Set(), limited = false } = {}) {
  if (kvGet(RESUME_SWITCH) !== '1' || now - lastLook < RESUME_EVERY_MS) return;
  lastLook = now;
  const { runs } = await deps.runs();
  for (const r of runs) {
    if (r.claude !== 'limit' || !r.board || stopped.has(r.session)) continue;
    const key = (r.tasks || []).find((t) => WORKING.has(t.status))?.key;
    if (key) { stopped.set(r.session, { key, why: 'limit', at: now }); keepStopped(); }
  }
  // a session no longer among the runs (its task left work) has nobody to tell
  const here = new Set(runs.map((r) => r.session));
  for (const [sid, v] of stopped) if (!here.has(sid) && now - v.at > SAY_WAIT_MS) forget(sid);
  if (limited) return;
  const map = chains(now);
  for (const r of runs) {
    const was = stopped.get(r.session);
    if (!was) continue;
    const late = now - was.at > SAY_WAIT_MS;
    // the words of a resume belong to the minutes after it: a day later they would start work nobody expects
    if (was.why === 'resume' && late) { forget(r.session); continue; }
    if (r.claude === 'limit') {
      // too early it stops at the limit again; the chain of tries holds how many times
      const at = resetAfter(r.resets, was.at - LINE_BACK_MS);
      if (at === null || now < at + LIMIT_GRACE_MS || !chainAllows(map[r.session], now)) continue;
    } else if (r.claude !== 'idle') { if (late) forget(r.session); continue; }
    const t = resolveTask(was.key);
    // a question open, the person took it up meanwhile, or the task left work (words would move it back, sayToTerminal): the
    // words of the board are not for it (an Enter would answer)
    const last = Date.parse((await deps.turn(r.session))?.items?.at(-1)?.at);
    if (!t || !WORKING.has(t.status) || waiting.has(t.id) || last > was.at) { forget(r.session); continue; }
    // under the lock of typing into this terminal, as the chat's queue and api-break.js: words may go between a look and the
    // typing. Something in the field is the person at work, or the words of a board killed before its Enter: an Enter here
    // sends it with ours
    const said = await typing(r.session, async () => {
      const empty = await deps.fieldEmpty(r.session);
      return empty === true ? (await deps.say(t, r.session, was.why === 'limit' ? say().go : say().goOn)) ?? {} : { field: empty };
    });
    if (said.field === null) continue; // tmux did not answer: the next look
    if (said.field === false) {
      was.held ??= now; // from here, not from `at`: a record of the limit is hours old by the reset
      if (now - was.held > SAY_WAIT_MS) forget(r.session); else keepStopped();
      continue;
    }
    if (said.err || said.refused) { logError('server', 'automations', `the words of ${was.key} did not reach Claude: ${said.refused || said.err?.message || said.err}`, r.session); continue; }
    forget(r.session);
    if (was.why === 'limit') { noted(map, r.session, now); boardNote(t.id, say().told); } else boardNote(t.id, say().resumed);
    return;
  }
  const launch = (() => { try { return JSON.parse(kvGet(RESUME_LAUNCH) || '{}') || {}; } catch { return {}; } })();
  for (const r of runs) {
    const keys = resumable(r);
    if (!keys || stopped.has(r.session) || !chainAllows(map[r.session], now)) continue;
    const tasks = keys.map((k) => resolveTask(k)).filter(Boolean);
    if (!tasks.length || tasks.some((t) => waiting.has(t.id) || t.blocked || parseLabels(t.labels).includes('ask'))) continue;
    if (howItStopped(await deps.turn(r.session), Boolean(r.board)) !== 'cut') continue;
    const project = db.prepare('SELECT slug, path FROM projects WHERE id = ?').get(tasks[0].project_id);
    if (!r.board) {
      const folder = await deps.folder(r.session);
      if (!folder || !project?.path || !(await sameFolder(folder, project.path))) continue;
    }
    noted(map, r.session, now); // a start refused counts as a try: it must not be asked for every minute for good
    // `claude --resume` stands at its prompt with the conversation back: only words set it to work, and only then has the
    // board gone on (the next look, once Claude Code is up). Kept before the start: a restart right after it loses them
    stopped.set(r.session, { key: keys[0], why: 'resume', at: now });
    keepStopped();
    let res;
    try {
      res = await app.inject({ method: 'POST', url: '/api/launch', headers: own, payload: { mode: 'board', resume: r.session, adopt: ADOPT_TOKEN, project: project.slug, keys, ...launch } });
    } catch (e) { forget(r.session); logError('server', 'automations', `resume of ${r.session}: ${e.message}`); return; }
    if (res.statusCode >= 300) { forget(r.session); logError('server', 'automations', `resume of ${keys.join(', ')}: ${res.statusCode} ${res.body.slice(0, 200)}`); }
    return;
  }
}
