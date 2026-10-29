
import { db, kvGet, kvSet, logError } from './db.js';
import { PORT } from './config.js';
import { emit } from './bus.js';
import { leadCheck } from './review-check.js';
import { pendingAsks } from './claude-asks.js';
import { currentLimits } from './claude-limits.js';
import { currentLive, currentQuestions } from './claude-live.js';
import { CHECK_LABEL, checkDescription, holdsCheck } from '../public/js/review-rules.js';
import { PERMISSION_MODES } from './phantom.js';
import { EFFORT_LEVELS } from './launch.js';

export const SWITCH_KEY = 'automations.on';
export const KINDS = ['finished-check'];
/** The pause the person may set, in minutes: the owner's "always 3, or as we say". */
export const DELAY_MAX_MIN = 120;
export const DELAY_DEFAULT_MIN = 3;
/** How many ended rules the section keeps showing. */
export const HISTORY_MAX = 20;
/** The words of a check the page gives with a rule — the same the ▶ of Review uses (review.js), in its language. */
export const WORDS = ['title', 'tasks', 'later', 'done', 'report', 'run', 'doTask'];
const WORD_MAX = 2000;
const TICK_MS = 5000;

export const automationsOn = () => kvGet(SWITCH_KEY) === '1';

/** A problem with the body of a new rule, or null. */
export function ruleProblem(b) {
  if (!b || typeof b !== 'object') return 'body: an object';
  if (typeof b.project !== 'string' || !b.project) return 'project: a project key';
  if (b.kind !== undefined && !KINDS.includes(b.kind)) return `kind: one of ${KINDS.join(', ')}`;
  if (b.delay_min !== undefined && !(Number.isInteger(b.delay_min) && b.delay_min >= 0 && b.delay_min <= DELAY_MAX_MIN)) {
    return `delay_min: whole minutes, 0…${DELAY_MAX_MIN}`;
  }
  const w = b.words;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return 'words: the words of the check';
  for (const k of WORDS) if (typeof w[k] !== 'string' || !w[k].trim() || w[k].length > WORD_MAX) return `words.${k}: text`;
  const l = b.launch;
  if (l !== undefined && (!l || typeof l !== 'object' || Array.isArray(l))) return 'launch: {permission, effort}';
  // known when the rule is set — not an hour later, after the batch and the pause, with a stray check left in To do (review)
  if (l?.permission !== undefined && !PERMISSION_MODES.includes(l.permission)) return `launch.permission: one of ${PERMISSION_MODES.join(', ')}`;
  if (l?.effort !== undefined && !EFFORT_LEVELS.includes(l.effort)) return `launch.effort: one of ${EFFORT_LEVELS.join(', ')}`;
  return null;
}

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** What the board knows of a project now, for `judge`. */
function projectNow(projectId, since) {
  const tasks = db.prepare(`SELECT t.id, (p.prefix || '-' || t.task_no) AS key, t.status, t.labels, t.blocked, t.updated_at, t.title
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ? AND t.status NOT IN ('done','cancelled')`).all(projectId)
    .map((t) => ({ ...t, labels: parseLabels(t.labels) }));
  // a task that went from work back to To do or Backlog after the rule was set: Claude handed it back with questions
  const back = db.prepare(`SELECT DISTINCT (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN task_events e ON e.task_id = t.id
    WHERE t.project_id = ? AND t.status IN ('todo','backlog') AND e.status IN ('todo','backlog') AND e.created_at >= ?
      AND (SELECT e2.status FROM task_events e2 WHERE e2.task_id = t.id AND e2.id < e.id ORDER BY e2.id DESC LIMIT 1) IN ('prep','doing','deploy')
      AND t.labels NOT LIKE '%"check"%'`).all(projectId, sqlTime(since)).map((r) => r.key);
  const lead = leadCheck(projectId);
  const made = lead ? db.prepare('SELECT created_at FROM tasks WHERE id = ?').get(lead.id)?.created_at : null;
  return { tasks, back, check: lead?.key || null, checkId: lead?.id ?? null, checkMade: made ? Date.parse(`${made.replace(' ', 'T')}Z`) : null };
}
function parseLabels(v) {
  try { const l = JSON.parse(v || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
const isCheck = (t) => t.labels.includes(CHECK_LABEL);

/** Where a rule stands: {phase, keys?, reason?}. Pure — `ctx` is what the board knows now:
    {tasks, back, check, live: {taskId: {claude}}, questions: Set(taskId), asks: Set(taskId), limited, now}.
    phase — `idle` (nothing has been worked on since it was set), `working` (keys: what holds it), `held` (reason:
    `question` | `ask` | `sent-back` | `limit` | `check-open` | `nothing`, keys where there are any), `ready`. */
export function judge(rule, ctx) {
  const working = ctx.tasks.filter((t) => holdsCheck(t, ctx.live, ctx.now)).map((t) => t.key);
  if (working.length) return { phase: 'working', keys: working };
  if (!rule.seen_work) return { phase: 'idle' };
  const asked = ctx.tasks.filter((t) => ctx.questions.has(t.id)).map((t) => t.key);
  if (asked.length) return { phase: 'held', reason: 'question', keys: asked };
  const asks = ctx.tasks.filter((t) => ctx.asks.has(t.id)).map((t) => t.key);
  if (asks.length) return { phase: 'held', reason: 'ask', keys: asks };
  if (ctx.back.length) return { phase: 'held', reason: 'sent-back', keys: ctx.back };
  if (ctx.limited) return { phase: 'held', reason: 'limit' };
  if (ctx.check) return { phase: 'held', reason: 'check-open', keys: [ctx.check] };
  const batch = reviewBatch(ctx.tasks);
  if (!batch.length) return { phase: 'held', reason: 'nothing' };
  return { phase: 'ready', keys: batch };
}
/** The keys a check takes: the project's tasks in Review, the longest waiting first — as the ▶ of the page (reviewGroups). */
export function reviewBatch(tasks) {
  return tasks.filter((t) => t.status === 'review' && !isCheck(t))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id)
    .map((t) => t.key);
}

/** The subscription is used up in one of its windows: a check started now would stop at once. */
function limitedNow(now) {
  const w = currentLimits(now).windows;
  return Object.values(w).some((x) => x && x.used >= 100);
}

/* What the page draws: the switch and the rules — the armed ones with where they stand, and the last ended ones.
   `phases` — the last judgement of each armed rule (the watch keeps it; a rule not judged yet is `idle`). */
const phases = new Map(); // rule id → {phase, keys?, reason?}
export function automationsView(now = Date.now()) {
  const rows = db.prepare(`SELECT a.*, p.slug AS project, p.name AS project_name,
      (SELECT p2.prefix || '-' || t.task_no FROM tasks t JOIN projects p2 ON p2.id = t.project_id WHERE t.id = a.task_id) AS check_key,
      (SELECT t.status FROM tasks t WHERE t.id = a.task_id) AS check_status
    FROM automations a JOIN projects p ON p.id = a.project_id
    WHERE a.state = 'armed' OR a.id IN (SELECT id FROM automations WHERE state != 'armed' ORDER BY ended_at DESC, id DESC LIMIT ?)
    ORDER BY a.state != 'armed', COALESCE(a.ended_at, a.created_at) DESC, a.id DESC`).all(HISTORY_MAX);
  return {
    on: automationsOn(),
    rules: rows.map((r) => {
      const j = r.state === 'armed' ? (phases.get(r.id) || { phase: 'idle' }) : null;
      return {
        id: r.id, project: r.project, project_name: r.project_name || r.project, kind: r.kind, delay_s: r.delay_s,
        state: r.state, created_at: r.created_at, ended_at: r.ended_at, error: r.error,
        check_key: r.check_key || null, check_status: r.check_status || null,
        ...(j ? { phase: j.phase, reason: j.reason || null, keys: j.keys || [] } : {}),
        due_at: r.state === 'armed' && r.ready_at != null && j?.phase === 'ready' ? r.ready_at + r.delay_s * 1000 : null,
      };
    }),
    now,
  };
}

let lastJson = '';
/** Send `automation.updated` with the view when it differs from the last one sent (`force` — always). */
export function announce(force = false) {
  const v = automationsView();
  const { now, ...shape } = v;
  const json = JSON.stringify(shape);
  if (!force && json === lastJson) return;
  lastJson = json;
  emit('automation.updated', v);
}

/** A new armed rule → its id, or {code, error, reason}. One armed rule per project. */
export function armRule(project, b, now = Date.now()) {
  const held = db.prepare("SELECT id FROM automations WHERE project_id = ? AND state = 'armed'").get(project.id);
  if (held) return { code: 409, error: 'this project already has an automation waiting', reason: 'armed', id: held.id };
  const words = Object.fromEntries(WORDS.map((k) => [k, b.words[k]]));
  const launch = { ...(b.launch?.permission ? { permission: b.launch.permission } : {}), ...(b.launch?.effort ? { effort: b.launch.effort } : {}) };
  const delay = (b.delay_min ?? DELAY_DEFAULT_MIN) * 60;
  // work already going on counts: the person sets the rule while Claude is at the batch (the owner's case)
  const r = db.prepare(`INSERT INTO automations (project_id, kind, delay_s, words, launch, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(project.id, b.kind || KINDS[0], delay, JSON.stringify(words), JSON.stringify(launch), now);
  return { id: Number(r.lastInsertRowid) };
}

/** Take an armed rule off (it goes to the history), or drop an ended one from it. → false when there is no such rule. */
export function dropRule(id, now = Date.now()) {
  const r = db.prepare('SELECT state FROM automations WHERE id = ?').get(id);
  if (!r) return false;
  if (r.state === 'armed') db.prepare("UPDATE automations SET state = 'cancelled', ended_at = ? WHERE id = ?").run(now, id);
  else db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  phases.delete(id);
  return true;
}

export function setAutomationsOn(on) {
  kvSet(SWITCH_KEY, on ? '1' : '0');
  if (!on) db.prepare("UPDATE automations SET ready_at = NULL WHERE state = 'armed'").run(); // the countdown starts anew
}

/* Only a rule still armed ends: «Take off» pressed while a check was being made and started had its `cancelled` turned
   into `fired` (review). */
const end = (id, state, fields = {}, now = Date.now()) => db.prepare("UPDATE automations SET state = ?, ended_at = ?, task_id = ?, error = ? WHERE id = ? AND state = 'armed'")
  .run(state, now, fields.task_id ?? null, fields.error ?? null, id).changes > 0;
const stillArmed = (id) => db.prepare('SELECT state FROM automations WHERE id = ?').get(id)?.state === 'armed';

/* The board's own address: the origin guard of the root instance (src/origin-guard.js) answers 421 to the Host
   `app.inject` sends by default (`localhost:80`) — the live board refused every rule that way, the test without the guard
   did not show it. */
const own = { host: `127.0.0.1:${PORT}` };

/** Make the check and start Claude on it, as ▶ of Review does — through the board's own routes. */
async function fire(app, rule, slug, batch, now) {
  if (!stillArmed(rule.id)) return;
  const words = JSON.parse(rule.words);
  const launch = JSON.parse(rule.launch || '{}');
  const description = checkDescription(batch, { tasks: words.tasks, later: words.later, done: words.done, report: words.report });
  const made = await app.inject({ method: 'POST', url: '/api/tasks', headers: own, payload: { project: slug, title: words.title, description, status: 'todo', labels: [CHECK_LABEL] } });
  const task = made.json();
  if (made.statusCode === 409 && task?.reason === 'check-open') {
    db.prepare('UPDATE automations SET ready_at = NULL WHERE id = ?').run(rule.id); // another check was made a moment ago: wait for it
    return;
  }
  if (made.statusCode >= 300) { end(rule.id, 'failed', { error: task?.error || `the check was not made (${made.statusCode})` }, now); return; }
  const taskId = task.id;
  if (!stillArmed(rule.id)) { // taken off while the check was being made: it stays in To do, Claude is not started
    db.prepare('UPDATE automations SET task_id = ? WHERE id = ?').run(taskId, rule.id);
    return;
  }
  const text = [words.run, `${words.doTask} ${task.key}`].join('\n');
  let res;
  let body;
  try {
    res = await app.inject({ method: 'POST', url: '/api/launch', headers: own, payload: { mode: 'board', text, project: slug, keys: [task.key], ...launch } });
    body = res.json();
  } catch (e) {
    // the check is made: the rule must not stay armed beside it, saying «the project already has an open check» (review)
    end(rule.id, 'failed', { task_id: taskId, error: `Claude did not start: ${e.message}` }, now);
    return;
  }
  if (res.statusCode >= 300) {
    // as on the page: the check stays in To do, ▶ on its card starts it once the cause is fixed
    end(rule.id, 'failed', { task_id: taskId, error: body?.reason ? `${body.reason}: ${body.error}` : body?.error || `Claude did not start (${res.statusCode})` }, now);
    return;
  }
  end(rule.id, 'fired', { task_id: taskId }, now);
}

/** One look at every armed rule: judge it, keep its countdown, fire the ones whose time has come. `app` — the board's
    Fastify instance (its routes make and start the check). */
export async function tickAutomations(app, now = Date.now()) {
  // a project archived under a rule takes it off — skipped for good, it stood «waiting» in the sidebar forever (review)
  const archived = db.prepare(`UPDATE automations SET state = 'cancelled', ended_at = ?, error = 'archived: the project was archived'
    WHERE state = 'armed' AND project_id IN (SELECT id FROM projects WHERE archived = 1)`).run(now).changes;
  const rules = db.prepare(`SELECT a.*, p.slug FROM automations a JOIN projects p ON p.id = a.project_id AND p.archived = 0
    WHERE a.state = 'armed' ORDER BY a.id`).all();
  if (!rules.length) { phases.clear(); if (archived) announce(); return; } // most boards: nothing to look at every 5 s
  const on = automationsOn();
  const live = Object.fromEntries(currentLive().map((t) => [t.id, { claude: t.claude }]));
  const questions = new Set(currentQuestions().map((q) => q.id));
  const asks = new Set(pendingAsks().map((a) => a.task_id));
  const limited = limitedNow(now);
  const armedIds = new Set(rules.map((r) => r.id));
  for (const id of phases.keys()) if (!armedIds.has(id)) phases.delete(id);
  for (const rule of rules) {
    try {
      const ctx = { ...projectNow(rule.project_id, rule.created_at), live, questions, asks, limited, now };
      let j = judge(rule, ctx);
      if (j.phase === 'working' && !rule.seen_work) { db.prepare('UPDATE automations SET seen_work = 1 WHERE id = ?').run(rule.id); rule.seen_work = 1; }
      /* A check made after the rule was set, by hand (▶ of Review, a card) — the rule's work is done: it ends `covered`.
         Kept armed, it fired a second check, three minutes after the first one ended, on what the first left in Review. */
      if (j.reason === 'check-open' && ctx.checkMade != null && ctx.checkMade >= rule.created_at - 999) {
        end(rule.id, 'covered', { task_id: ctx.checkId }, now);
        continue;
      }
      if (!on && j.phase === 'ready') j = { phase: 'held', reason: 'off' };
      phases.set(rule.id, j);
      if (j.phase !== 'ready') {
        if (rule.ready_at != null) db.prepare('UPDATE automations SET ready_at = NULL WHERE id = ?').run(rule.id);
        continue;
      }
      if (rule.ready_at == null) { db.prepare('UPDATE automations SET ready_at = ? WHERE id = ?').run(now, rule.id); continue; }
      if (now - rule.ready_at < rule.delay_s * 1000) continue;
      await fire(app, rule, rule.slug, j.keys, now);
    } catch (e) {
      logError('server', 'automations', `automation ${rule.id}: ${e.message}`, e.stack);
    }
  }
  announce();
}

let ticking = false;
/** The watch: a look every few seconds, one at a time. Not on the preview board (server.js starts it on the live one). */
export function startAutomations(app) {
  const tick = () => {
    if (ticking) return;
    ticking = true;
    tickAutomations(app).catch((e) => logError('server', 'automations', e.message, e.stack)).finally(() => { ticking = false; });
  };
  tick();
  setInterval(tick, TICK_MS).unref();
}
