import { db, logError } from './db.js';
import { emit } from './bus.js';
import { automationsOn, launchOnBoard } from './automations.js';
import { currentLimits } from './claude-limits.js';
import { PERMISSION_MODES } from './phantom.js';
import { EFFORT_LEVELS } from './launch.js';
import { batchesOf, epicSettings, saveLaunch, saveRun } from './epics.js';

export const RUN_TICK_MS = 5000;
/** A window of the subscription past this share holds the next portion (the same bound as the queue of To do). */
export const RUN_LIMIT_PCT = 80;
const WORD_MAX = 2000;
const IN_PLAY = new Set(['prep', 'doing', 'deploy']);
/** A batch every task of which is out of work: handed in (ready, review) or accepted. Pure. */
export const handedIn = (batch) => batch.tasks.length > 0 && batch.tasks.every((t) => HANDED.has(t.status));
const HANDED = new Set(['ready', 'review', 'done', 'cancelled']);
/** The states of a batch's run the board still leads. */
export const LEADING = new Set(['starting', 'running', 'accepting']);
/** The starts awaited in this process (`<epic>:<batch>`): a `starting` run not among them is one the board went down in
    the middle of — its tasks say whether it happened. Not a time: a start that copies a large worktree takes minutes. */
const inFlight = new Set();
const flightKey = (epicId, batchId) => `${epicId}:${batchId}`;

/** A task a portion may take: in To do or Backlog, not blocked, not the person's (noclaude), not one that waits for the
    person at the chat (`ask`), not a check. The rest of a batch is started by hand. */
export const runnable = (t) => (t.status === 'todo' || t.status === 'backlog') && !t.blocked && !t.epic
  && !t.labels.includes('noclaude') && !t.labels.includes('ask') && !t.labels.includes('check');
/** The next portion of a batch: up to `portion` runnable tasks in the batch's order, of one project — the first one's (a
    start of Claude is in one folder). Null — nothing to start. Pure. */
export function nextPortion(batch, portion) {
  const free = batch.tasks.filter(runnable);
  if (!free.length) return null;
  const project = free[0].project;
  return { project, keys: free.filter((t) => t.project === project).slice(0, portion).map((t) => t.key) };
}
/** Where a running batch stands. Pure. → {phase: 'closed'} | {phase: 'working', keys} — the portion still in work |
    {phase: 'next', project, keys} | {phase: 'accepting'} — nothing left to start, the person's acceptance is awaited. */
export function batchJudge(batch, run, portion) {
  if (batch.closed) return { phase: 'closed' };
  const byKey = new Map(batch.tasks.map((t) => [t.key, t]));
  const working = (run.keys || []).filter((k) => IN_PLAY.has(byKey.get(k)?.status));
  if (working.length) return { phase: 'working', keys: working };
  const next = nextPortion(batch, portion);
  return next ? { phase: 'next', ...next } : { phase: 'accepting' };
}
/** The batch the board starts by itself after `doneId` closed: the next one in order that has something to start — not
    one the person stopped, nor one whose start failed (that waits for the person), nor one already led. Pure. */
export function nextBatch(batches, doneId, portion, run = {}) {
  const at = batches.findIndex((b) => b.id === doneId);
  for (const b of batches.slice(at + 1)) {
    const state = run[b.id]?.state;
    if (state === 'stopped' || state === 'failed' || LEADING.has(state)) continue;
    if (!b.closed && nextPortion(b, portion)) return b;
  }
  return null;
}

/** A problem with what the page sends to start a batch, or null. */
export function runProblem(b) {
  const l = b?.launch;
  if (l !== undefined && (!l || typeof l !== 'object' || Array.isArray(l))) return { error: 'launch: {permission, effort}', field: 'launch' };
  if (l?.permission !== undefined && !PERMISSION_MODES.includes(l.permission)) return { error: `launch.permission: one of ${PERMISSION_MODES.join(', ')}`, field: 'launch' };
  if (l?.effort !== undefined && !EFFORT_LEVELS.includes(l.effort)) return { error: `launch.effort: one of ${EFFORT_LEVELS.join(', ')}`, field: 'launch' };
  const w = b?.words;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'words: {run, doTask, epic} in the page\'s language', field: 'words' };
  for (const k of ['run', 'doTask', 'epic']) if (typeof w[k] !== 'string' || !w[k].trim() || w[k].length > WORD_MAX) return { error: `words.${k}: text`, field: 'words' };
  if (w.through !== undefined && (typeof w.through !== 'string' || !w.through.trim() || w.through.length > WORD_MAX)) return { error: 'words.through: text', field: 'words' };
  if (b.force !== undefined && typeof b.force !== 'boolean') return { error: 'force: true or false', field: 'force' };
  return null;
}
export function portionText(words, epicKey, batch, keys, through = false) {
  const fill = (s) => String(s).replaceAll('{key}', epicKey).replaceAll('{n}', String(batch.n)).replaceAll('{title}', batch.title ? ` «${batch.title}»` : '');
  return [words.run, fill(words.epic), ...(through && words.through ? [fill(words.through)] : []), `${words.doTask} ${keys.join(', ')}`].join('\n');
}

const announce = (epicId) => {
  const key = db.prepare("SELECT (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(epicId)?.key;
  if (key) emit('task.epic', { id: epicId, key });
};
/** The other batch of the epic the board is running now, or null. */
export function runningBatch(epicId, exceptId) {
  const { run } = epicSettings(epicId);
  const batches = batchesOf(epicId);
  for (const [id, r] of Object.entries(run)) {
    const b = batches.find((x) => x.id === Number(id));
    if (Number(id) !== exceptId && b && !b.closed && LEADING.has(r.state)) return b;
  }
  return null;
}

/* One start of Claude through the board's own route (`launchOnBoard` of the Automations — `POST /api/launch` inside the
   board, a task a live Claude still holds left out), with the person's permission and effort. */
async function launch(app, epicKey, batch, project, keys, saved, through) {
  const { res, keys: started } = await launchOnBoard(app, (k) => ({ mode: 'board', project, keys: k, text: portionText(saved.words, epicKey, batch, k, through),
    ...(saved.permission ? { permission: saved.permission } : {}), ...(saved.effort ? { effort: saved.effort } : {}) }), keys);
  const body = (() => { try { return res.json(); } catch { return {}; } })();
  return res.statusCode < 300 ? { ok: true, keys: started } : { ok: false, code: res.statusCode, body };
}

/** Starts the next portion of a batch: the run is marked before the start is awaited (a tick meanwhile sees `starting`). */
async function startPortion(app, epic, batch, portion) {
  const s = epicSettings(epic.id);
  const run = { ...s.run, [batch.id]: { state: 'starting', keys: portion.keys, project: portion.project, at: Date.now() } };
  saveRun(epic.id, run);
  const flight = flightKey(epic.id, batch.id);
  inFlight.add(flight);
  let r;
  try { r = await launch(app, epic.key, batch, portion.project, portion.keys, s.launch, s.through); }
  catch (e) { r = { ok: false, code: 500, body: { error: e.message } }; }
  finally { inFlight.delete(flight); }
  const now = epicSettings(epic.id).run;
  const mine = now[batch.id];
  if (!mine || mine.state !== 'starting') return r; // stopped meanwhile
  now[batch.id] = r.ok ? { state: 'running', keys: r.keys, project: portion.project, at: Date.now() }
    : { state: 'failed', keys: portion.keys, project: portion.project, at: Date.now(), error: `${r.body?.reason ? `${r.body.reason}: ` : ''}${r.body?.error || `Claude did not start (${r.code})`}` };
  saveRun(epic.id, now);
  if (!r.ok) logError('server', 'epic-run', `${epic.key} batch ${batch.n}: ${now[batch.id].error}`);
  announce(epic.id);
  return r;
}

/** The person pressed «Start the batch». → {code, ...} for the route. */
export async function runBatch(app, epic, batchId, b) {
  const batches = batchesOf(epic.id);
  const batch = batches.find((x) => x.id === batchId);
  if (!batch) return { code: 404, error: 'no such batch in this epic' };
  const s = epicSettings(epic.id);
  // a second press (a double click, another tab) while this batch runs would start a portion on top of the first
  if (LEADING.has(s.run[batch.id]?.state)) return { code: 409, reason: 'running', error: `batch ${batch.n} of ${epic.key} is already running` };
  const portion = nextPortion(batch, s.portion);
  if (!portion) {
    const left = batch.tasks.filter((t) => !['done', 'cancelled'].includes(t.status) && !runnable(t) && !IN_PLAY.has(t.status));
    return { code: 409, reason: 'nothing', error: batch.closed ? `batch ${batch.n} is accepted — nothing to start` : `batch ${batch.n} has nothing the board starts${left.length ? ` (by hand: ${left.map((t) => t.key).join(', ')})` : ''}`, keys: left.map((t) => t.key) };
  }
  const other = runningBatch(epic.id, batch.id);
  if (other && !b.force) return { code: 409, reason: 'batch-running', error: `batch ${other.n} of ${epic.key} is still running — start batch ${batch.n} next to it?`, batch: other.n };
  saveLaunch(epic.id, { words: { run: b.words.run, doTask: b.words.doTask, epic: b.words.epic, ...(b.words.through ? { through: b.words.through } : {}) }, ...(b.launch?.permission ? { permission: b.launch.permission } : {}), ...(b.launch?.effort ? { effort: b.launch.effort } : {}) });
  const r = await startPortion(app, epic, batch, portion);
  if (!r.ok) return { code: r.code, ...r.body };
  return { code: 200, started: r.keys };
}

/** The person pressed «Stop»: the batch's portion in work goes on, no next one starts. */
export function stopBatch(epic, batchId) {
  const s = epicSettings(epic.id);
  const r = s.run[batchId];
  if (!r) return false;
  s.run[batchId] = { ...r, state: 'stopped', at: Date.now() };
  saveRun(epic.id, s.run);
  announce(epic.id);
  return true;
}

const limitHigh = (now) => { const w = currentLimits(now).windows; return [w.five_hour, w.seven_day].some((x) => x && x.used >= RUN_LIMIT_PCT); };

/** One look at every epic the board runs a batch of. Each batch is read afresh before it is judged — a start awaited for
    another batch may take seconds, and a «Stop» pressed meanwhile must not be written over. */
export async function tickEpics(app, now = Date.now()) {
  // only epics with a run the board still leads: finished ones stay in `run` for the card, and are not read every tick
  const rows = db.prepare(`SELECT e.task_id AS id, (p.prefix || '-' || t.task_no) AS key FROM epics e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND (e.run LIKE '%"state":"running"%' OR e.run LIKE '%"state":"accepting"%' OR e.run LIKE '%"state":"starting"%')`).all();
  for (const epic of rows) {
    for (const idText of Object.keys(epicSettings(epic.id).run)) {
      const id = Number(idText);
      const s = epicSettings(epic.id);
      let r = s.run[idText];
      if (!r) continue;
      const save = (next) => { const run = epicSettings(epic.id).run; if (next) run[idText] = next; else delete run[idText]; saveRun(epic.id, run); announce(epic.id); };
      // a start the board went down in the middle of: its tasks say whether it happened (in prep) or not (still in To do)
      if (r.state === 'starting' && !inFlight.has(flightKey(epic.id, id))) { r = { ...r, state: 'running' }; save(r); }
      if (!['running', 'accepting'].includes(r.state)) continue;
      const batches = batchesOf(epic.id);
      const batch = batches.find((b) => b.id === id);
      if (!batch) { save(null); continue; }
      const j = batchJudge(batch, r, s.portion);
      if (j.phase === 'working') continue;
      if (j.phase === 'accepting') {
        const next = s.through && handedIn(batch) && automationsOn() && !runningBatch(epic.id, id) ? nextBatch(batches, id, s.portion, s.run) : null;
        if (next && limitHigh(now)) { if (r.hold !== 'limit-high') save({ ...r, hold: 'limit-high' }); continue; }
        if (next) { save({ ...r, state: 'passed', hold: undefined, at: now }); await startPortion(app, epic, next, nextPortion(next, s.portion)); continue; }
        if (r.state !== 'accepting' || r.hold) save({ ...r, state: 'accepting', hold: undefined });
        continue;
      }
      if (j.phase === 'next') {
        if (limitHigh(now)) { if (r.hold !== 'limit-high') save({ ...r, hold: 'limit-high' }); continue; }
        await startPortion(app, epic, batch, j);
        continue;
      }
      // closed: the person accepted every task of it. The next batch, if it is owed and the limit holds it, keeps this one
      // waiting (`hold`) — marked done, the start would be forgotten
      const next = (s.auto_next || s.through) && automationsOn() && !runningBatch(epic.id, id) ? nextBatch(batches, id, s.portion, s.run) : null;
      if (next && limitHigh(now)) { if (r.hold !== 'limit-high') save({ ...r, hold: 'limit-high' }); continue; }
      save({ ...r, state: 'done', hold: undefined, at: now });
      if (next) await startPortion(app, epic, next, nextPortion(next, s.portion));
    }
  }
}

let ticking = false;
export function startEpicRuns(app) {
  const tick = () => {
    if (ticking) return;
    ticking = true;
    tickEpics(app).catch((e) => logError('server', 'epic-run', e.message, e.stack)).finally(() => { ticking = false; });
  };
  setInterval(tick, RUN_TICK_MS).unref();
}
