
import { db, kvGet, kvSet, logError, uiLang } from './db.js';
import { PORT } from './config.js';
import { emit } from './bus.js';
import { leadCheck } from './review-check.js';
import { pendingAsks } from './claude-asks.js';
import { currentLimits } from './claude-limits.js';
import { currentLive, currentQuestions } from './claude-live.js';
import { CHECK_LABEL, atWork, checkDescription, holdsCheck } from '../public/js/review-rules.js';
import { PERMISSION_MODES } from './phantom.js';
import { EFFORT_LEVELS } from './launch.js';
import { ADOPT_TOKEN } from './claude-sessions.js';
import { RESUME_LAUNCH, RESUME_SWITCH, boardNote, tickResume } from './auto-resume.js';
import { HEALTH_SWITCH, healthSoon, tickHealth } from './auto-health.js';

export const SWITCH_KEY = 'automations.on';
export const QUEUE_KIND = 'todo-queue';
export const SCHEDULE_CHECK = 'schedule-check';
export const SCHEDULE_GROOM = 'schedule-groom';
export const KINDS = ['finished-check', QUEUE_KIND, SCHEDULE_CHECK, SCHEDULE_GROOM];
export const QUEUE_BATCH = 5;
export const QUEUE_LIMIT_PCT = 80;
/** A scheduled rule runs within this long of its time; later — the Mac slept — it waits for the next one (the owner's word). */
export const SLOT_WINDOW_MS = 10 * 60_000;
const GROOM_KEYS_MAX = 100;
/** The pause the person may set, in minutes: the owner's "always 3, or as we say". */
export const DELAY_MAX_MIN = 120;
export const DELAY_DEFAULT_MIN = 3;
/** How many ended rules the section keeps showing. */
export const HISTORY_MAX = 20;
/** The words of a check the page gives with a rule — the same the ▶ of Review uses (review.js), in its language. */
export const WORDS = ['title', 'tasks', 'later', 'done', 'report', 'run', 'doTask'];
const WORD_MAX = 2000;
export const FIRES_DAY_MAX = 10;
export const CHECKS_AT_ONCE = 2;
export const FIX_ROUNDS = 2;
const DAY_MS = 24 * 3600 * 1000;
const TICK_MS = 5000;

export const automationsOn = () => kvGet(SWITCH_KEY) === '1';

const scheduled = (kind) => kind === SCHEDULE_CHECK || kind === SCHEDULE_GROOM;
/** The words a kind of rule needs. */
const wordsOf = (kind) => (kind === QUEUE_KIND ? ['run', 'doTask'] : kind === SCHEDULE_GROOM ? ['run', 'groom'] : WORDS);

/** A problem with the body of a new rule, or null. */
export function ruleProblem(b) {
  if (!b || typeof b !== 'object') return 'body: an object';
  if (typeof b.project !== 'string' || !b.project) return 'project: a project key';
  if (b.kind !== undefined && !KINDS.includes(b.kind)) return `kind: one of ${KINDS.join(', ')}`;
  if (b.delay_min !== undefined && !(Number.isInteger(b.delay_min) && b.delay_min >= 0 && b.delay_min <= DELAY_MAX_MIN)) {
    return `delay_min: whole minutes, 0…${DELAY_MAX_MIN}`;
  }
  if (b.repeat !== undefined && typeof b.repeat !== 'boolean') return 'repeat: true or false';
  if (b.fix !== undefined && typeof b.fix !== 'boolean') return 'fix: true or false';
  if (b.fix && !b.repeat) return 'fix: only for a repeating rule';
  if (b.fix && (typeof b.words?.back !== 'string' || !b.words.back.trim() || b.words.back.length > WORD_MAX)) return 'words.back: text';
  const w = b.words;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return 'words: the words of the check';
  for (const k of wordsOf(b.kind)) if (typeof w[k] !== 'string' || !w[k].trim() || w[k].length > WORD_MAX) return `words.${k}: text`;
  if (scheduled(b.kind)) {
    const p = b.plan;
    if (!p || typeof p !== 'object' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.at))) return 'plan.at: a time, HH:MM';
    if (p.day !== undefined && p.day !== null && !(Number.isInteger(p.day) && p.day >= 0 && p.day <= 6)) return 'plan.day: a day of the week, 0…6, or null for every day';
  }
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
    `question` | `ask` | `sent-back` | `limit` | `check-open` | `nothing` | `day-cap` | `busy`, keys where there are
    any), `ready`. `dayFull` — the rule's checks of the day are used up, `busy` — enough checks run on the board. */
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
  if (ctx.dayFull) return { phase: 'held', reason: 'day-cap' };
  if (ctx.busy) return { phase: 'held', reason: 'busy' };
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

function firesOf(rule, now) {
  try { const l = JSON.parse(rule.fires || '[]'); return Array.isArray(l) ? l.filter((x) => now - x < DAY_MS) : []; } catch { return []; }
}
function checksRunning(live, now) {
  return db.prepare(`SELECT t.id, t.status, t.labels, t.blocked, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND t.status IN ('prep','doing','deploy') AND t.labels LIKE '%"check"%'`).all()
    .map((t) => ({ ...t, labels: parseLabels(t.labels) })).filter((t) => isCheck(t) && atWork(t, live, now)).length;
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
    extras: extrasView(),
    rules: rows.map((r) => {
      const j = r.state === 'armed' ? (phases.get(r.id) || { phase: scheduled(r.kind) ? 'planned' : 'idle' }) : null;
      return {
        id: r.id, project: r.project, project_name: r.project_name || r.project, kind: r.kind, delay_s: r.delay_s,
        state: r.state, created_at: r.created_at, ended_at: r.ended_at, error: r.error,
        repeat: Boolean(r.repeat), fix: Boolean(r.fix), plan: scheduled(r.kind) ? JSON.parse(r.plan || '{}') : null, ...(r.repeat ? { fires_n: firesOf(r, now).length, fires_max: FIRES_DAY_MAX } : {}),
        check_key: r.check_key || null, check_status: r.check_status || null,
        ...(j ? { phase: j.phase, reason: j.reason || null, keys: j.keys || [] } : {}),
        // a queue whose start was refused tries again after a pause: that is its next moment, not a 0:00 standing for minutes
        due_at: r.state === 'armed' && r.ready_at != null && j?.phase === 'ready' ? Math.max(r.ready_at + r.delay_s * 1000, r.kind === 'todo-queue' ? fixWait.get(r.id) || 0 : 0) : null,
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

/** A new armed rule → its id, or {code, error, reason}. One armed rule of a kind per project. */
export function armRule(project, b, now = Date.now()) {
  const kind = b.kind || KINDS[0];
  const held = db.prepare("SELECT id FROM automations WHERE project_id = ? AND kind = ? AND state = 'armed'").get(project.id, kind);
  if (held) return { code: 409, error: 'this project already has an automation waiting', reason: 'armed', id: held.id };
  const words = Object.fromEntries([...wordsOf(kind), ...(b.fix ? ['back'] : [])].map((k) => [k, b.words[k]]));
  const launch = { ...(b.launch?.permission ? { permission: b.launch.permission } : {}), ...(b.launch?.effort ? { effort: b.launch.effort } : {}) };
  const delay = (b.delay_min ?? DELAY_DEFAULT_MIN) * 60;
  // work already going on counts: the person sets the rule while Claude is at the batch (the owner's case)
  const r = db.prepare(`INSERT INTO automations (project_id, kind, delay_s, words, launch, created_at, repeat, fix, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(project.id, kind, delay, JSON.stringify(words), JSON.stringify(launch), now, b.repeat || kind !== KINDS[0] ? 1 : 0, b.fix ? 1 : 0,
      JSON.stringify(scheduled(kind) ? { at: b.plan.at, day: b.plan.day ?? null } : {}));
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
function waitAgain(rule, taskId, now, fired, error = null) {
  const fires = fired ? [...firesOf(rule, now), now] : firesOf(rule, now);
  db.prepare(`UPDATE automations SET seen_work = 0, ready_at = NULL, task_id = ?, rearmed_at = ?, fires = ?, error = ? WHERE id = ? AND state = 'armed'`)
    .run(taskId, now, JSON.stringify(fires), error, rule.id);
}
/* A check that did not start: a one-shot rule ends with it; a repeating one stays — a passing failure must not stop the
   person's automation for good — and says it. The check, if made, waits in To do and holds the rule (`check-open`). */
function failed(rule, fields, now) {
  if (rule.repeat) waitAgain(rule, fields.task_id ?? rule.task_id, now, false, fields.error);
  else end(rule.id, 'failed', fields, now);
}
const stillArmed = (id) => db.prepare('SELECT state FROM automations WHERE id = ?').get(id)?.state === 'armed';

/* The board's own address: the origin guard of the root instance (src/origin-guard.js) answers 421 to the Host
   `app.inject` sends by default (`localhost:80`) — the live board refused every rule that way, the test without the guard
   did not show it. */
const own = { host: `127.0.0.1:${PORT}` };

/** Make the check and start Claude on it, as ▶ of Review does — through the board's own routes. → whether Claude started. */
async function fire(app, rule, slug, batch, now) {
  if (!stillArmed(rule.id)) return false;
  const words = JSON.parse(rule.words);
  const launch = JSON.parse(rule.launch || '{}');
  const description = checkDescription(batch, { tasks: words.tasks, later: words.later, done: words.done, back: words.back, report: words.report });
  const made = await app.inject({ method: 'POST', url: '/api/tasks', headers: own, payload: { project: slug, title: words.title, description, status: 'todo', labels: [CHECK_LABEL] } });
  const task = made.json();
  if (made.statusCode === 409 && task?.reason === 'check-open') {
    db.prepare('UPDATE automations SET ready_at = NULL WHERE id = ?').run(rule.id); // another check was made a moment ago: wait for it
    return false;
  }
  if (made.statusCode >= 300) { failed(rule, { error: task?.error || `the check was not made (${made.statusCode})` }, now); return false; }
  const taskId = task.id;
  if (!stillArmed(rule.id)) { // taken off while the check was being made: it stays in To do, Claude is not started
    db.prepare('UPDATE automations SET task_id = ? WHERE id = ?').run(taskId, rule.id);
    return false;
  }
  const text = [words.run, `${words.doTask} ${task.key}`].join('\n');
  let res;
  let body;
  try {
    res = await app.inject({ method: 'POST', url: '/api/launch', headers: own, payload: { mode: 'board', text, project: slug, keys: [task.key], ...launch } });
    body = res.json();
  } catch (e) {
    // the check is made: the rule must not stay armed beside it, saying «the project already has an open check» (review)
    failed(rule, { task_id: taskId, error: `Claude did not start: ${e.message}` }, now);
    return false;
  }
  if (res.statusCode >= 300) {
    // as on the page: the check stays in To do, ▶ on its card starts it once the cause is fixed
    failed(rule, { task_id: taskId, error: body?.reason ? `${body.reason}: ${body.error}` : body?.error || `Claude did not start (${res.statusCode})` }, now);
    return false;
  }
  if (rule.repeat) waitAgain(rule, taskId, now, true); else end(rule.id, 'fired', { task_id: taskId }, now);
  return true;
}

export const extrasView = () => ({ resume: kvGet(RESUME_SWITCH) === '1', health: kvGet(HEALTH_SWITCH) === '1' });
export function setExtras(b) {
  if (b.resume !== undefined) {
    kvSet(RESUME_SWITCH, b.resume ? '1' : '0');
    if (b.launch) kvSet(RESUME_LAUNCH, JSON.stringify(b.launch));
  }
  if (b.health !== undefined) {
    kvSet(HEALTH_SWITCH, b.health ? '1' : '0');
    if (b.health) healthSoon();
  }
}
export function extrasProblem(b) {
  if (!b || typeof b !== 'object') return 'body: an object';
  if (b.resume !== undefined && typeof b.resume !== 'boolean') return 'resume: true or false';
  if (b.health !== undefined && typeof b.health !== 'boolean') return 'health: true or false';
  const l = b.launch;
  if (l !== undefined && (!l || typeof l !== 'object' || Array.isArray(l))) return 'launch: {permission, effort}';
  if (l?.permission !== undefined && !PERMISSION_MODES.includes(l.permission)) return `launch.permission: one of ${PERMISSION_MODES.join(', ')}`;
  if (l?.effort !== undefined && !EFFORT_LEVELS.includes(l.effort)) return `launch.effort: one of ${EFFORT_LEVELS.join(', ')}`;
  return null;
}

export function returnedTasks(projectId, since, checkId) {
  return db.prepare(`SELECT t.id, (p.prefix || '-' || t.task_no) AS key, t.labels, t.blocked,
      (SELECT e.created_at FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS at
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status = 'todo'
      AND (SELECT e.status FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1 OFFSET 1) = 'review'
      AND (SELECT e.created_at FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) >= ?
      AND (SELECT e.session_id FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) IN (SELECT session_id FROM task_sessions WHERE task_id = ?)
    ORDER BY t.priority DESC, t.position, t.id`).all(projectId, sqlTime(since), checkId ?? 0)
    .map((t) => ({ ...t, labels: parseLabels(t.labels), at: Date.parse(`${String(t.at).replace(' ', 'T')}Z`) }))
    .filter((t) => !t.blocked && !t.labels.includes('noclaude') && !t.labels.includes('ask') && !isCheck(t));
}
const FIX_WORDS = {
  ru: { sent: (n) => `Проверка вернула задачу: доска запустила исправление (круг ${n} из ${FIX_ROUNDS}), замечание — в комментариях выше.`, out: `Проверка вернула задачу снова, а ${FIX_ROUNDS} круга исправления уже прошли: она ждёт тебя.` },
  en: { sent: (n) => `The check returned the task: the board started the fix (round ${n} of ${FIX_ROUNDS}), the remark is in the comments above.`, out: `The check returned the task again, and ${FIX_ROUNDS} rounds of fixing are over: it waits for you.` },
};
const FIX_RETRY_MS = 5 * 60_000;
const fixWait = new Map(); // rule id → when a refused start of a fix is tried again
/** → whether Claude was started on what the rule's check returned. */
async function fixReturned(app, rule, slug, since, now) {
  let rounds = {};
  try { rounds = JSON.parse(rule.rounds || '{}') || {}; } catch { /* starts anew */ }
  if (now < (fixWait.get(rule.id) || 0) || !stillArmed(rule.id) || !automationsOn()) return false;
  const fresh = returnedTasks(rule.project_id, since, rule.task_id).filter((t) => !(t.at <= (rounds[t.id]?.at ?? 0)));
  if (!fresh.length) return false;
  const say = FIX_WORDS[uiLang() === 'en' ? 'en' : 'ru'];
  const go = [];
  for (const t of fresh) {
    if ((rounds[t.id]?.n || 0) < FIX_ROUNDS) go.push(t);
    else { rounds[t.id] = { ...rounds[t.id], at: now }; boardNote(t.id, say.out); }
  }
  const keep = () => db.prepare('UPDATE automations SET rounds = ? WHERE id = ?').run(JSON.stringify(rounds), rule.id);
  if (!go.length) { keep(); return false; }
  const words = JSON.parse(rule.words);
  const keys = go.map((t) => t.key);
  const res = await app.inject({ method: 'POST', url: '/api/launch', headers: own,
    payload: { mode: 'board', text: [words.run, `${words.doTask} ${keys.join(', ')}`].join('\n'), project: slug, keys, makeRoom: ADOPT_TOKEN, ...JSON.parse(rule.launch || '{}') } });
  keep();
  if (res.statusCode >= 300) { // no round is spent on a start that did not happen: it is tried again in a while
    const body = res.json();
    fixWait.set(rule.id, now + FIX_RETRY_MS);
    db.prepare('UPDATE automations SET error = ? WHERE id = ?').run(body?.reason ? `${body.reason}: ${body.error}` : body?.error || `Claude did not start (${res.statusCode})`, rule.id);
    return false;
  }
  for (const t of go) rounds[t.id] = { n: (rounds[t.id]?.n || 0) + 1, at: now };
  keep();
  db.prepare('UPDATE automations SET error = NULL, seen_work = 1 WHERE id = ?').run(rule.id);
  for (const t of go) boardNote(t.id, say.sent(rounds[t.id].n));
  return true;
}

const SUMMARY_ROWS = 12;
export async function awaySummary(since, runs) {
  const after = sqlTime(since);
  const rows = (where) => db.prepare(`SELECT (p.prefix || '-' || t.task_no) AS key, t.title, COALESCE(p.name, p.slug) AS project
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND t.labels NOT LIKE '%"noclaude"%' AND t.labels NOT LIKE '%"check"%' AND ${where}
    ORDER BY t.updated_at DESC`).all(after);
  const moved = (s) => `t.status = '${s}' AND (SELECT e.created_at FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) >= ?`;
  const stuck = (runs || []).filter((r) => r.claude === 'gone' && r.session).flatMap((r) => (r.tasks || []).filter((t) => ['prep', 'doing', 'deploy'].includes(t.status)).map((t) => t.key));
  const named = stuck.length ? db.prepare(`SELECT (p.prefix || '-' || t.task_no) AS key, t.title, COALESCE(p.name, p.slug) AS project
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.archived = 0 AND (p.prefix || '-' || t.task_no) IN (SELECT value FROM json_each(?))
      AND t.labels NOT LIKE '%"noclaude"%' AND t.labels NOT LIKE '%"check"%'
      AND EXISTS (SELECT 1 FROM task_sessions s WHERE s.task_id = t.id AND s.last_seen >= ?)`).all(JSON.stringify(stuck), after) : [];
  const cut = (list) => ({ n: list.length, tasks: list.slice(0, SUMMARY_ROWS) });
  return {
    handed: cut(rows(moved('review'))),
    accepted: cut(rows(moved('done'))),
    returned: cut(rows(`t.status IN ('todo','prep','doing') AND (SELECT e.created_at FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) >= ?
      AND (SELECT e.status FROM task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1 OFFSET 1) = 'review'`)),
    stuck: cut(named),
  };
}

export function queueBatch(tasks, keep = new Set()) {
  return tasks.filter((t) => t.status === 'todo' && !t.blocked && !isCheck(t) && !t.labels.includes('noclaude') && !t.labels.includes('ask') && !keep.has(t.id))
    .sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.priority || 0) - (a.priority || 0) || (a.position || 0) - (b.position || 0) || a.id - b.id)
    .slice(0, QUEUE_BATCH).map((t) => t.key);
}
/** Where a queue stands. Pure, as `judge`; `over` — a window of the limit is past QUEUE_LIMIT_PCT. */
export function queueJudge(ctx) {
  const working = ctx.tasks.filter((t) => holdsCheck(t, ctx.live, ctx.now)).map((t) => t.key);
  if (working.length) return { phase: 'working', keys: working };
  const asked = ctx.tasks.filter((t) => ctx.questions.has(t.id)).map((t) => t.key);
  if (asked.length) return { phase: 'held', reason: 'question', keys: asked };
  const asks = ctx.tasks.filter((t) => ctx.asks.has(t.id)).map((t) => t.key);
  if (asks.length) return { phase: 'held', reason: 'ask', keys: asks };
  if (ctx.back.length) return { phase: 'held', reason: 'sent-back', keys: ctx.back };
  // work cut off is no project finished: a batch over it, session after session, would strand a day's worth of tasks
  const cut = ctx.tasks.filter((t) => ['prep', 'doing', 'deploy'].includes(t.status) && !t.blocked && !isCheck(t) && !t.labels.includes('noclaude')).map((t) => t.key);
  if (cut.length) return { phase: 'held', reason: 'unfinished', keys: cut };
  if (ctx.check) return { phase: 'held', reason: 'check-open', keys: [ctx.check] };
  if (ctx.limited || ctx.over) return { phase: 'held', reason: 'limit-high' };
  if (!ctx.batch.length) return { phase: 'held', reason: 'queue-empty' };
  if (ctx.dayFull) return { phase: 'held', reason: 'day-cap' };
  return { phase: 'ready', keys: ctx.batch };
}
const overLimit = (now) => { const w = currentLimits(now).windows; return [w.five_hour, w.seven_day].some((x) => x && x.used >= QUEUE_LIMIT_PCT); };
/** The tasks a project's fix rule has given up on: they wait for the person, and no queue takes them. */
function givenUp(projectId) {
  const out = new Set();
  for (const r of db.prepare("SELECT rounds FROM automations WHERE project_id = ? AND state = 'armed' AND fix = 1").all(projectId)) {
    let rounds = {};
    try { rounds = JSON.parse(r.rounds || '{}') || {}; } catch { /* none */ }
    for (const [id, x] of Object.entries(rounds)) if (x.n >= FIX_ROUNDS) out.add(Number(id));
  }
  return out;
}
async function startBatch(app, rule, slug, keys, text, now, extra = {}) {
  if (!stillArmed(rule.id) || !automationsOn()) return false; // taken off while the look went on: nothing starts
  const go = (k) => app.inject({ method: 'POST', url: '/api/launch', headers: own, payload: { mode: 'board', text: typeof text === 'function' ? text(k) : text, project: slug, keys: k, ...extra, ...JSON.parse(rule.launch || '{}') } });
  let res = await go(keys);
  // a task a live Claude still holds (it stands at its prompt, the check that returned it) does not hold the free ones
  const held = res.statusCode === 409 ? res.json().running : null;
  const free = Array.isArray(held) ? keys.filter((k) => !held.includes(k)) : [];
  if (free.length) res = await go(free);
  if (res.statusCode < 300) { waitAgain(rule, rule.task_id, now, true); return true; }
  fixWait.set(rule.id, now + FIX_RETRY_MS);
  const body = res.json();
  waitAgain(rule, rule.task_id, now, false, body?.reason ? `${body.reason}: ${body.error}` : body?.error || `Claude did not start (${res.statusCode})`);
  return false;
}
async function tickQueue(app, rule, ctx, now) {
  const tasks = db.prepare('SELECT id, pinned, priority, position FROM tasks WHERE project_id = ?').all(rule.project_id);
  const more = new Map(tasks.map((t) => [t.id, t]));
  const full = ctx.tasks.map((t) => ({ ...t, ...more.get(t.id) }));
  let j = queueJudge({ ...ctx, over: overLimit(now), batch: queueBatch(full, givenUp(rule.project_id)) });
  if (j.phase === 'ready' && !ctx.on) j = { phase: 'held', reason: 'off' };
  phases.set(rule.id, j);
  if (j.phase !== 'ready') { if (rule.ready_at != null) db.prepare('UPDATE automations SET ready_at = NULL WHERE id = ?').run(rule.id); return; }
  if (rule.ready_at == null) { db.prepare('UPDATE automations SET ready_at = ? WHERE id = ?').run(now, rule.id); return; }
  if (now - rule.ready_at < rule.delay_s * 1000) return;
  if (now < (fixWait.get(rule.id) || 0)) return;
  const words = JSON.parse(rule.words);
  await startBatch(app, rule, rule.slug, j.keys, (keys) => [words.run, `${words.doTask} ${keys.join(', ')}`].join('\n'), now);
}

/** The moment of the run due at `now`, or null. Local time of this computer. Pure. */
export function slotOf(plan, now) {
  const [h, m] = String(plan?.at || '').split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const d = new Date(now);
  if (plan.day !== null && plan.day !== undefined && d.getDay() !== plan.day) return null;
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return now >= at && now - at < SLOT_WINDOW_MS ? at : null;
}
async function tickSchedule(app, rule, ctx, now, running) {
  const plan = JSON.parse(rule.plan || '{}');
  const slot = slotOf(plan, now);
  const done = slot == null || (rule.rearmed_at != null && rule.rearmed_at >= slot);
  phases.set(rule.id, { phase: 'planned' });
  if (done || !ctx.on) return false;
  const hold = (reason, keys) => { phases.set(rule.id, { phase: 'held', reason, ...(keys ? { keys } : {}) }); return false; };
  if (ctx.limited) return hold('limit');
  const asked = ctx.tasks.filter((t) => ctx.questions.has(t.id) || ctx.asks.has(t.id)).map((t) => t.key);
  if (asked.length) return hold('question', asked); // the run waits, within its time, for what goes on in the project
  const working = ctx.tasks.filter((t) => holdsCheck(t, ctx.live, now)).map((t) => t.key);
  if (working.length) return hold('at-work', working);
  if (rule.kind === SCHEDULE_CHECK) {
    if (ctx.check) return hold('check-open', [ctx.check]);
    if (running >= CHECKS_AT_ONCE) return hold('busy');
    const batch = reviewBatch(ctx.tasks);
    if (!batch.length) { waitAgain(rule, rule.task_id, now, false); return false; }
    return fire(app, rule, rule.slug, batch, now);
  }
  const words = JSON.parse(rule.words);
  const keys = db.prepare(`SELECT p.prefix || '-' || t.task_no AS key FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status = 'backlog' ORDER BY t.position, t.id LIMIT ?`).all(rule.project_id, GROOM_KEYS_MAX).map((r) => r.key);
  if (!keys.length) { waitAgain(rule, rule.task_id, now, false); return false; }
  // no keys in the request: grooming moves no task (a task the start names would go to Preparation)
  return startBatch(app, rule, rule.slug, undefined, [words.run, `${words.groom}\n${keys.join(' ')}`].join('\n'), now, { noTasks: ADOPT_TOKEN });
}

/** One look at every armed rule: judge it, keep its countdown, fire the ones whose time has come. `app` — the board's
    Fastify instance (its routes make and start the check). */
export async function tickAutomations(app, now = Date.now()) {
  if (automationsOn()) {
    await tickResume(app, now, { waiting: new Set([...currentQuestions().map((q) => q.id), ...pendingAsks().map((a) => a.task_id)]), limited: limitedNow(now) })
      .catch((e) => logError('server', 'automations', `resume: ${e.message}`, e.stack));
    await tickHealth(app, now).catch((e) => logError('server', 'automations', `health: ${e.message}`, e.stack));
  }
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
  let running = checksRunning(live, now);
  const armedIds = new Set(rules.map((r) => r.id));
  for (const id of phases.keys()) if (!armedIds.has(id)) phases.delete(id);
  for (const rule of rules) {
    try {
      const since = rule.rearmed_at ?? rule.created_at;
      const dayFull = Boolean(rule.repeat) && firesOf(rule, now).length >= FIRES_DAY_MAX;
      const ctx = { ...projectNow(rule.project_id, since), live, questions, asks, limited, now, dayFull, busy: running >= CHECKS_AT_ONCE };
      if (rule.kind === QUEUE_KIND) { await tickQueue(app, rule, { ...ctx, on }, now); continue; }
      if (scheduled(rule.kind)) { if (await tickSchedule(app, rule, { ...ctx, on }, now, running)) running += 1; continue; }
      let j = judge(rule, ctx);
      if (j.phase === 'working' && !rule.seen_work) { db.prepare('UPDATE automations SET seen_work = 1 WHERE id = ?').run(rule.id); rule.seen_work = 1; }
      /* A check made after the rule was set, by hand (▶ of Review, a card) — the rule's work is done: it ends `covered`.
         Kept armed, it fired a second check, three minutes after the first one ended, on what the first left in Review. */
      // not its own: created within the second of `rearmed_at`, it read as made by hand, and the batch finished while it
      // ran was dropped
      if (j.reason === 'check-open' && ctx.checkMade != null && ctx.checkMade >= since - 999 && ctx.checkId !== rule.task_id) {
        if (rule.repeat) { waitAgain(rule, ctx.checkId, now, false); continue; } // that batch is checked: the next one
        end(rule.id, 'covered', { task_id: ctx.checkId }, now);
        continue;
      }
      if (!on && j.phase === 'ready') j = { phase: 'held', reason: 'off' };
      if (rule.fix && on && j.phase !== 'working' && !ctx.check && !limited && !ctx.tasks.some((t) => questions.has(t.id) || asks.has(t.id))
        && await fixReturned(app, rule, rule.slug, since, now)) { phases.set(rule.id, { phase: 'working', keys: [] }); continue; }
      phases.set(rule.id, j);
      if (j.phase !== 'ready') {
        if (rule.ready_at != null) db.prepare('UPDATE automations SET ready_at = NULL WHERE id = ?').run(rule.id);
        continue;
      }
      if (rule.ready_at == null) { db.prepare('UPDATE automations SET ready_at = ? WHERE id = ?').run(now, rule.id); continue; }
      if (now - rule.ready_at < rule.delay_s * 1000) continue;
      if (await fire(app, rule, rule.slug, j.keys, now)) running += 1;
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
