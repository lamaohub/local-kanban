import { db } from '../db.js';
import { bus } from '../bus.js';

const noclaudeFilter = (alias = '', only = false) => `${alias}labels ${only ? '' : 'NOT '}LIKE '%"noclaude"%'`;
const LIVE_TASKS = (alias = '') => `${alias}project_id IN (SELECT id FROM projects WHERE archived = 0)`;

const SINCE_LOCAL_MIDNIGHT = "datetime('now','localtime','start of day', ?, 'utc')";
const sinceArgFor = (days) => `-${days - 1} days`;

export default async function dashboardRoutes(app) {
  app.get('/api/stats', () => {
    const r = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(work_seconds), 0) AS sec
      FROM tasks WHERE status = 'done' AND done_at >= ${SINCE_LOCAL_MIDNIGHT}
        AND ${LIVE_TASKS()} AND ${noclaudeFilter()}
    `).get(sinceArgFor(7));
    return { week_done: r.n, week_seconds: r.sec };
  });

  const RANGE_DAYS = { week: 7, month: 30, half: 182, year: 365 };

  const DASH_TTL = 2000;
  const dashCache = new Map(); // range -> { at, data }
  bus.on('event', () => dashCache.clear());

  app.get('/api/dashboard', (req) => {
    const range = Object.hasOwn(RANGE_DAYS, req.query.range) ? req.query.range : 'week';
    const hit = dashCache.get(range);
    if (hit && Date.now() - hit.at < DASH_TTL) return hit.data;
    const LIVE_EVENTS = (alias = '') => `${alias}task_id IN (SELECT id FROM tasks WHERE ${LIVE_TASKS()})`;
    const LIVE = LIVE_TASKS();
    const NOT_NOCLAUDE = noclaudeFilter();
    const IS_NOCLAUDE = noclaudeFilter('', true);
    const sinceArg = sinceArgFor(RANGE_DAYS[range]);
    const period = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(work_seconds), 0) AS sec,
             AVG((julianday(done_at) - julianday(created_at)) * 24) AS cyc
      FROM tasks WHERE status = 'done' AND ${LIVE} AND ${NOT_NOCLAUDE} AND done_at >= datetime('now','localtime','start of day', ?, 'utc')
    `).get(sinceArg);
    const active = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN ('todo','prep','doing','deploy','review') AND ${LIVE} AND ${NOT_NOCLAUDE}`).get().n;
    const doneTotal = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND ${LIVE} AND ${NOT_NOCLAUDE}`).get().n;
    const manualPeriod = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND ${LIVE} AND ${IS_NOCLAUDE} AND done_at >= datetime('now','localtime','start of day', ?, 'utc')`).get(sinceArg).n;
    const manualTotal = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND ${LIVE} AND ${IS_NOCLAUDE}`).get().n;
    const todoReady = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo' AND ${LIVE}`).get().n;
    const backlog = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'backlog' AND ${LIVE}`).get().n;

    const waitSel = `
      SELECT (p.prefix || '-' || t.task_no) AS key, t.title, p.name AS project,
             t.priority, t.blocked_reason AS reason,
             (julianday('now') - julianday(t.updated_at)) * 24 AS idle_h
      FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived = 0`;
    const review = db.prepare(`${waitSel} WHERE t.status = 'review' ORDER BY t.priority DESC, t.updated_at DESC LIMIT 40`).all()
      .map((t) => ({ key: t.key, title: t.title, project: t.project, priority: t.priority }));
    const blocked = db.prepare(`${waitSel} WHERE t.blocked = 1 AND t.status NOT IN ('done','cancelled') ORDER BY t.updated_at DESC LIMIT 40`).all()
      .map((t) => ({ key: t.key, title: t.title, project: t.project, reason: t.reason }));
    const stale = db.prepare(`${waitSel} WHERE t.status IN ('doing','deploy') AND t.updated_at <= datetime('now','-2 hours') ORDER BY t.updated_at ASC LIMIT 40`).all()
      .map((t) => ({ key: t.key, title: t.title, project: t.project, hours: Math.floor(t.idle_h) }));

    const STALE_DAYS = 14;
    const NEXT_FRESH_DAYS = 60;
    const activeRows = db.prepare(`
      SELECT (p.prefix || '-' || t.task_no) AS key, t.title, p.name AS project, t.status, t.priority,
             (t.description IS NULL OR trim(t.description) = '') AS no_desc,
             CAST(julianday('now') - julianday(t.updated_at) AS INTEGER) AS idle_days,
             CAST(julianday('now') - julianday(t.created_at) AS INTEGER) AS age_days
      FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived = 0
      WHERE t.status IN ('backlog','todo')
      ORDER BY t.priority DESC, t.updated_at DESC`).all();
    const planRow = (t) => ({ key: t.key, title: t.title, project: t.project, status: t.status, priority: t.priority, idle_days: t.idle_days });

    const FUNNEL_ST = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review'];
    const funMap = Object.fromEntries(db.prepare(
      `SELECT status, COUNT(*) n FROM tasks WHERE status IN ('backlog','todo','prep','doing','deploy','review')
         AND ${LIVE_TASKS()} GROUP BY status`).all().map((r) => [r.status, r.n]));
    const funnel = FUNNEL_ST.map((s) => ({ status: s, n: funMap[s] || 0 }));

    const nextScore = (t) => t.priority * 100 + Math.min(t.age_days, NEXT_FRESH_DAYS);
    const next = activeRows.filter((t) => !t.no_desc && t.priority > 0)
      .sort((a, b) => nextScore(b) - nextScore(a)).slice(0, 6).map(planRow);

    const matrix = { hot: [], queue: [], decide: [], idea: [] };
    for (const t of activeRows) {
      const important = t.priority >= 2;
      const stale = t.idle_days >= STALE_DAYS;
      const q = important ? (stale ? 'hot' : 'queue') : (stale ? 'decide' : 'idea');
      if (matrix[q].length < 30) matrix[q].push(planRow(t));
    }

    const health = {
      abandoned: activeRows.filter((t) => t.idle_days >= STALE_DAYS).slice(0, 20).map((t) => ({ ...planRow(t), days: t.idle_days })),
      no_desc: activeRows.filter((t) => t.no_desc).slice(0, 20).map(planRow),
      no_priority: activeRows.filter((t) => t.priority === 0).slice(0, 20).map(planRow),
    };

    const planning = { funnel, next, matrix, health };

    const heatDays = db.prepare(`SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS d, COUNT(DISTINCT task_id) AS n FROM task_events WHERE ${LIVE_EVENTS()} AND created_at >= datetime('now','localtime','start of day', ?, 'utc') GROUP BY d ORDER BY d`).all(sinceArg);
    const heatTime = db.prepare(`SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS w, CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS h, COUNT(DISTINCT task_id) AS n FROM task_events WHERE ${LIVE_EVENTS()} AND created_at >= datetime('now','localtime','start of day', ?, 'utc') GROUP BY w, h`).all(sinceArg);
    const donePerDay = db.prepare(`SELECT strftime('%Y-%m-%d', done_at, 'localtime') AS d, COUNT(*) AS n FROM tasks WHERE ${LIVE} AND done_at IS NOT NULL AND done_at >= datetime('now','localtime','start of day', ?, 'utc') GROUP BY d ORDER BY d`).all(sinceArg);
    const topProjects = db.prepare("SELECT p.name, COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.archived = 0 AND t.status = 'done' AND t.done_at >= datetime('now','localtime','start of day', ?, 'utc') GROUP BY p.id ORDER BY n DESC, p.name LIMIT 6").all(sinceArg);

    const recent = db.prepare(`
      SELECT e.status, e.created_at, (p.prefix || '-' || t.task_no) AS key, t.title, p.name AS project
      FROM task_events e
      JOIN (SELECT task_id, MAX(id) AS mid FROM task_events GROUP BY task_id) last ON last.mid = e.id
      JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
      ORDER BY e.id DESC LIMIT 30
    `).all();

    const peak = db.prepare("SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS h, COUNT(*) AS n FROM task_events GROUP BY h ORDER BY n DESC LIMIT 1").get();
    const since = db.prepare("SELECT strftime('%Y-%m-%d', MIN(created_at), 'localtime') AS d FROM task_events").get().d;
    const rangeStart = db.prepare("SELECT strftime('%Y-%m-%d', 'now', 'localtime', 'start of day', ?) AS d").get(sinceArg).d;
    const rangeSince = since && since > rangeStart ? since : rangeStart;

    const out = {
      range,
      summary: { done_period: period.n, active, work_seconds_period: period.sec, cycle_hours_period: period.cyc, done_total: doneTotal, manual_period: manualPeriod, manual_total: manualTotal },
      queue: { todo_ready: todoReady, backlog },
      waiting: { review, blocked, stale },
      planning,
      heat_days: heatDays,
      heat_time: heatTime,
      done_per_day: donePerDay,
      top_projects: topProjects,
      recent,
      range_since: rangeSince,
      fun: { done_total: doneTotal, peak_hour: peak ? peak.h : null, since },
    };
    dashCache.set(range, { at: Date.now(), data: out });
    return out;
  });
}
