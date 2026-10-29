
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db.js';
import { emit } from './bus.js';
import { claudeDir } from './config.js';
import { SESSION_ID_RE, WAIT_MAX_H, freshLaunchSessions, isBoardSession, sessionTranscript, waitingLaunches } from './claude-sessions.js';
import { sessionEvents, sessionWindows } from './work-feed.js';
import { boardLook, endedBySignal, phantomPane } from './phantom.js';
import { taskOfSession } from './claude-asks.js';
import { waitsOwnWork } from './own-wait.js';
import { syncClocks } from './work-clock.js';
import { breakNow, breakState, recoverDue, settleBreak } from './api-break.js';

const KNOWN = new Set(['busy', 'waiting', 'idle']);
const STATUS_AS = { shell: 'background' };
export const LEFTOVER_MS = 2 * 3600_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM: it runs, just not ours
}

const START_TTL_MS = 60_000;
const startSeen = new Map(); // `${pid} ${procStart}` → {same, at}
/** pid → its start as `ps -o lstart=` prints it (C locale, UTC); a pid ps said nothing of is not in the map.
    null — ps did not run. */
export function processStarts(pids) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 3000 }, (err, out) => {
      if (err && typeof err.code !== 'number') { resolve(null); return; } // no ps, or it hung
      const starts = new Map(); // ps exits 1 when none of the pids runs; what it did print still counts
      for (const line of String(out || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
        if (m) starts.set(Number(m[1]), m[2]);
      }
      resolve(starts);
    });
  });
}
async function sameProcesses(entries, startsOf) {
  const now = Date.now();
  for (const [k, v] of startSeen) if (now - v.at >= START_TTL_MS) startSeen.delete(k);
  const key = (e) => `${e.pid} ${e.procStart}`;
  const ask = entries.filter((e) => !startSeen.has(key(e)));
  if (ask.length) {
    const got = await startsOf([...new Set(ask.map((e) => e.pid))]);
    if (got) for (const e of ask) if (got.has(e.pid)) startSeen.set(key(e), { same: got.get(e.pid) === e.procStart, at: now });
  }
  for (const e of entries) if (startSeen.get(key(e))?.same === false) e.alive = false; // nothing from ps: kill stays the word
}

/** Session id → {status, pid, alive, since} from Claude Code's registry of live sessions. */
export async function readRegistry(isAlive = alive, startsOf = processStarts) {
  const dir = join(claudeDir(), 'sessions');
  const out = new Map();
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  const read = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(await readFile(join(dir, n), 'utf8')); } catch { continue; } // half-written or foreign
    const sid = typeof d?.sessionId === 'string' ? d.sessionId.toLowerCase() : '';
    if (!SESSION_ID_RE.test(sid)) continue;
    read.push([sid, {
      status: typeof d.status === 'string' ? d.status : '',
      pid: d.pid,
      alive: isAlive(d.pid),
      since: Number(d.statusUpdatedAt || d.updatedAt) || null,
      procStart: typeof d.procStart === 'string' ? d.procStart : null,
    }]);
  }
  const check = read.map(([, e]) => e).filter((e) => e.alive && e.procStart);
  if (check.length) await sameProcesses(check, startsOf);
  for (const [sid, e] of read) {
    const { procStart, ...entry } = e;
    const prev = out.get(sid);
    // a resumed session can leave an older file behind: the live one wins, then the fresher one
    if (!prev || (entry.alive && !prev.alive) || (entry.alive === prev.alive && (entry.since || 0) > (prev.since || 0))) out.set(sid, entry);
  }
  return out;
}

export function stateOf(entry) {
  if (!entry || !entry.alive) return 'gone';
  // a status this board has not seen yet is still a session that is alive and doing something
  if (STATUS_AS[entry.status]) return STATUS_AS[entry.status];
  return KNOWN.has(entry.status) ? entry.status : 'busy';
}

/** The state of a session read with its screen: `bg` — commands in the background under the input box, `over` — its
    turn over above it. At its prompt with commands in the background, or `busy` in the registry for work it handed off
    with its turn over (Claude Code 2.1.300 says busy while a background agent runs), it is 'background'. */
export function screenState(entry, { bg = false, over: turnOver = false } = {}) {
  const st = stateOf(entry);
  if (st === 'idle' && bg) return 'background';
  if (st === 'busy' && turnOver) return 'background';
  return st;
}

export function worksPastTasks(entry, bgOnScreen, at = Date.now(), overOnScreen = false) {
  const st = screenState(entry, { bg: bgOnScreen, over: overOnScreen });
  if (st === 'busy') return 'busy';
  if (st !== 'background') return null;
  return entry.since && at - entry.since >= LEFTOVER_MS ? null : 'background';
}

/** A Claude past its tasks in work that waits at its prompt for the person — 'idle', or 'waiting' when its registry
    says so — or null: at work (worksPastTasks), gone, or at its prompt for LEFTOVER_MS and more. */
export function waitsPastTasks(entry, bgOnScreen, at = Date.now(), overOnScreen = false) {
  const st = screenState(entry, { bg: bgOnScreen, over: overOnScreen });
  if (st !== 'idle' && st !== 'waiting') return null;
  return entry.since && at - entry.since >= LEFTOVER_MS ? null : st;
}

/** The board's own terminal of a session it started is closed: no pane, or Claude in it has exited. A session the
    board did not start (the Terminal, the app) has no terminal of the board to ask — false. */
export async function boardPaneGone(sid, paneOf = phantomPane) {
  if (!isBoardSession(sid)) return false;
  const st = await paneOf(sid);
  return !st || Boolean(st.dead);
}
/** {exit, interrupted[, lost]} of the board's own terminal of `sid` whose Claude has exited — or is gone with its
    conversation kept (`lost`); null — not the board's, alive, tmux did not answer, or nothing to go on from. */
export async function boardPaneEnded(sid, paneOf = phantomPane, transcriptOf = sessionTranscript) {
  if (!isBoardSession(sid)) return null;
  const st = await paneOf(sid);
  if (!st) return (await transcriptOf(sid)) ? { exit: null, interrupted: true, lost: true } : null;
  return st.dead ? { exit: st.exit ?? null, interrupted: endedBySignal(st) } : null;
}

/** The Claude state of every task in work that a session is tied to: [{id, key, project, project_name, title, status, claude, since}].
    `paneOf` — the state of a board's terminal (phantomPane by default, see boardPaneGone), replaceable in tests. */
export async function liveTasks(isAlive = alive, paneOf = undefined, limitedNow = limited, backgroundNow = background, overNow = over, ownWork = waitsOwnWork, brokeOf = breakNow) {
  const rows = db.prepare(`SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, p.name AS project_name, t.title, t.status,
      s.session_id, s.last_seen
    FROM task_sessions s JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE t.status IN ('prep','doing','deploy')
    ORDER BY t.id, s.last_seen DESC, s.session_id`).all();
  const waiting = waitingLaunches();
  if (!rows.length && !waiting.size) return [];
  const registry = await readRegistry(isAlive);
  const fresh = rows.length ? freshLaunchSessions() : new Set();
  const latest = new Map(); // task → its most recent session
  for (const r of rows) if (!latest.has(r.id)) latest.set(r.id, r);
  const focusOf = new Map(); // session → the task it is on right now, or null
  const endedOf = new Map();
  const out = [];
  for (const r of latest.values()) {
    if (waiting.has(r.id)) continue; // started anew: an older session of the task says nothing about it
    let claude = stateOf(registry.get(r.session_id));
    // board started it and its terminal there is closed already: it exited at once and will not show up
    if (claude === 'gone' && fresh.has(r.session_id) && !(await boardPaneGone(r.session_id, paneOf))) claude = 'starting';
    const hit = claude !== 'gone' ? limitedNow.get(r.session_id) : undefined;
    if (hit) {
      out.push({ id: r.id, key: r.key, project: r.project, project_name: r.project_name, title: r.title, status: r.status, claude: 'limit', since: registry.get(r.session_id)?.since ?? null, resets: hit.resets });
      continue;
    }
    // handed off, with its turn over on the screen
    const handedOff = claude === 'busy' && overNow.has(r.session_id);
    if (claude !== 'gone' && claude !== 'starting') claude = screenState(registry.get(r.session_id), { bg: backgroundNow.has(r.session_id), over: overNow.has(r.session_id) });
    let bg = false;
    if (claude === 'background' && !(await ownWork(r.session_id))) { claude = 'idle'; bg = true; }
    if (claude !== 'gone' && claude !== 'starting') {
      if (!focusOf.has(r.session_id)) {
        focusOf.set(r.session_id, sessionWindows(sessionEvents(r.session_id)).find((w) => w.to === null)?.task_id ?? null);
      }
      if (focusOf.get(r.session_id) !== r.id) continue; // the session is on another task of its batch
    }
    const since = handedOff ? null : registry.get(r.session_id)?.since ?? null;
    if (claude === 'gone' && !endedOf.has(r.session_id)) endedOf.set(r.session_id, await boardPaneEnded(r.session_id, paneOf));
    const cut = claude === 'gone' && endedOf.get(r.session_id)?.interrupted;
    let broke = null;
    if (claude === 'idle') {
      const brk = await brokeOf(r.session_id);
      if (brk) broke = breakState(r.session_id, brk, { board: isBoardSession(r.session_id), task: r.id });
      // review: only Claude's own words end the chain — the board's «go on» last (not answered yet, the registry a look
      // behind) would reset its tries, and a network that stays down would get «go on» every 15 s for good
      else if (brk === null) settleBreak(r.session_id);
    }
    out.push({ id: r.id, key: r.key, project: r.project, project_name: r.project_name, title: r.title, status: r.status, claude, since, ...(bg ? { background: true } : {}), ...(cut ? { interrupted: true } : {}), ...(broke ? { broke } : {}) });
  }
  const task = db.prepare(`SELECT t.id, (p.prefix || '-' || t.task_no) AS key, p.slug AS project, p.name AS project_name, t.title, t.status
    FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived = 0 WHERE t.id = ?`);
  for (const [id, ageH] of waiting) {
    const t = task.get(id);
    if (t) out.push({ ...t, claude: ageH < WAIT_MAX_H ? 'unsent' : 'gone', since: null });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** [{id, key, project, title}] of the tasks the board's terminals ask about now. `asking` — the sessions (boardQuestions). */
export async function terminalQuestions(asking = async () => (await boardLook()).questions) {
  const sids = await asking();
  if (!sids.length) return [];
  const title = db.prepare('SELECT title FROM tasks WHERE id = ?');
  const out = new Map();
  for (const sid of sids) {
    const t = taskOfSession(sid);
    if (t && !out.has(t.id)) out.set(t.id, { id: t.id, key: t.key, project: t.project, title: title.get(t.id)?.title ?? '' });
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/* ── the watch: compute every few seconds, ring only on a change ──────────────── */
let current = [];
let currentJson = '[]';
let background = new Set();
let over = new Set();
let limited = new Map();
let limitMissed = new Set(); // …that lost the warning line for one look: kept one look more, a redraw is no reset
let overMissed = new Set();
let boardLive = new Set();
let workProjects = [];
let questionsNow = [];
let lastLook = { live: [], questions: [], background: [], over: [], limited: [] };

/** The last computed states — for the dashboard, which answers synchronously from its cache. */
export const currentLive = () => current;
export const currentBackground = () => background;
export const currentOver = () => over;
export const currentLimited = () => limited;
export const currentBoardLive = () => boardLive;
export const currentWorkProjects = () => workProjects;
export const currentQuestions = () => questionsNow;
async function activeProjects(isAlive, alive, bg, ov) {
  if (!alive.size) return [];
  const reg = await readRegistry(isAlive);
  const holds = new Set(db.prepare(`SELECT DISTINCT s.session_id FROM task_sessions s JOIN tasks t ON t.id = s.task_id
    WHERE t.status IN ('prep','doing','deploy')`).all().map((r) => r.session_id));
  const sids = [...alive].filter((sid) => {
    const how = worksPastTasks(reg.get(sid), bg.has(sid), undefined, ov.has(sid));
    return how === 'busy' || (how && !holds.has(sid));
  });
  if (!sids.length) return [];
  return db.prepare(`SELECT DISTINCT p.slug FROM task_sessions s JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND s.session_id IN (SELECT value FROM json_each(?)) ORDER BY p.slug`).all(JSON.stringify(sids)).map((r) => r.slug);
}

/** Compute the states now; `task.live` goes out only if they (or the terminals' questions, or which of them work in
    the background) differ from the last ones. `look` — what the board's terminals show (boardLook). */
export async function refreshLive(isAlive = alive, look = boardLook) {
  let seen = await look();
  if (seen.failed) seen = lastLook; else lastLook = seen;
  const alive = new Set(seen.live || []);
  const hits = new Map((seen.limited || []).map((x) => [x.sid, { resets: x.resets }]));
  // the stop would ring again when it comes back
  const missed = new Set();
  for (const [sid, v] of limited) {
    if (!hits.has(sid) && alive.has(sid) && !limitMissed.has(sid)) { hits.set(sid, v); missed.add(sid); }
  }
  const bg = [...(seen.background || [])].sort();
  const ovSeen = new Set(seen.over || []);
  const ovMissed = new Set();
  for (const sid of over) if (!ovSeen.has(sid) && alive.has(sid) && !overMissed.has(sid)) { ovSeen.add(sid); ovMissed.add(sid); }
  const ov = [...ovSeen].sort();
  const next = await liveTasks(isAlive, undefined, hits, new Set(bg), new Set(ov));
  syncClocks(next);
  const questions = await terminalQuestions(async () => seen.questions);
  questionsNow = questions;
  const projects = await activeProjects(isAlive, alive, new Set(bg), new Set(ov));
  const json = JSON.stringify([next, questions, bg, ov, projects]);
  over = new Set(ov); // kept even when nothing the page sees changed: the next look compares with it
  limited = hits;
  limitMissed = missed;
  overMissed = ovMissed;
  boardLive = alive;
  if (json === currentJson) return false;
  current = next;
  currentJson = json;
  background = new Set(bg);
  workProjects = projects;
  emit('task.live', { tasks: next, questions, projects });
  return true;
}

const LIVE_EVERY_MS = 3000;
let running = false;
let again = false;
/** Compute the states now, one computation at a time: one asked for while another runs follows it, so a change
    made meanwhile is not left to the next tick. ▶ asks too: the tasks it started go to prep that very moment, and
    their badge should not wait up to three seconds to say "starting". */
export function liveTick() {
  if (running) { again = true; return; }
  running = true;
  refreshLive().catch(() => {}).finally(() => {
    running = false;
    recoverDue().catch(() => {});
    if (again) { again = false; liveTick(); }
  });
}
export function startLiveWatch() {
  liveTick();
  setInterval(liveTick, LIVE_EVERY_MS).unref();
}
