import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { PORT } from './config.js';
import { db, kvGet, kvSet, logError, uiLang } from './db.js';
import { NORMS, healthView } from './health.js';
import { readRegistry, stateOf } from './claude-live.js';
import { noclaudeFilter } from './task-shape.js';
import { fixable } from '../public/js/health-rules.js';

export const HEALTH_SWITCH = 'automations.health';
const LAST_KEY = 'automations.health.last';
export const HEALTH_EVERY_MS = 24 * 3600_000;
const own = { host: `127.0.0.1:${PORT}` };
const TITLES = { ru: 'Ужать CLAUDE.md', en: 'Shrink CLAUDE.md' };
export const HEALTH_DOCS = 'https://code.claude.com/docs/en/memory';
const fmt = (n) => n.toLocaleString('ru-RU');
const WORDS = {
  ru: (file, chars, lines, by = 'автоматизация') => `${file}: ${fmt(chars)} ${WORDS.ruN(chars, ['знак', 'знака', 'знаков'])} и ${fmt(lines)} ${WORDS.ruN(lines, ['строка', 'строки', 'строк'])} при норме ${fmt(NORMS.file_chars)} знаков и ${fmt(NORMS.lines)} строк. Claude Code предупреждает о большом файле на старте и хуже следует длинным инструкциям.\n\nОптимизировать по документации Claude Code: ${HEALTH_DOCS}\n- в файле оставить общее для любой работы в проекте;\n- подробности по темам — в правила .claude/rules/<тема>.md с paths: (грузятся, только когда Claude работает с этими файлами) или в CLAUDE.md подпапки;\n- @-импорты место не экономят: файл грузится вместе с CLAUDE.md;\n- устаревшее переписать, историю починок не копить — она в git log.\n\nЗадачу завела доска: раздел «Здоровье», ${by}.`,
  en: (file, chars, lines, by = 'an automation') => `${file}: ${fmt(chars)} characters and ${fmt(lines)} lines, the norm is ${fmt(NORMS.file_chars)} characters and ${fmt(NORMS.lines)} lines. Claude Code warns about a large file at the start and follows long instructions worse.\n\nOptimize it by the docs of Claude Code: ${HEALTH_DOCS}\n- keep in the file what any work in the project needs;\n- the details of a topic go to rules .claude/rules/<topic>.md with paths: (they load only when Claude works with those files) or to the CLAUDE.md of a subfolder;\n- @-imports save no room: the file loads together with the CLAUDE.md;\n- rewrite what is out of date, keep no history of fixes — it is in git log.\n\nThe board opened this task: the Health section, ${by}.`,
  button: { ru: 'кнопка «Починить»', en: 'the button «Fix»' }, // who opened it, for the words above
  ruN: (n, [one, few, many]) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; },
};

export const ruCount = WORDS.ruN; // for the test of the forms

/** The projects whose own CLAUDE.md is past the norm. Pure. */
export const heavyProjects = (view) => (view.projects || []).filter((p) => p.main && p.main.chars > view.norms.file_chars);

/** Forget the last walk: switched on, the board looks at once. */
export const healthSoon = () => kvSet(LAST_KEY, '0');

export async function tickHealth(app, now) {
  if (kvGet(HEALTH_SWITCH) !== '1' || now - Number(kvGet(LAST_KEY) || 0) < HEALTH_EVERY_MS) return;
  kvSet(LAST_KEY, String(now));
  const projects = db.prepare('SELECT id, slug, name, path, category FROM projects WHERE archived = 0 ORDER BY position, name COLLATE NOCASE').all();
  const view = await healthView(projects);
  const lang = uiLang() === 'en' ? 'en' : 'ru';
  const seen = db.prepare(`SELECT 1 FROM tasks WHERE project_id = ? AND title IN (?, ?) AND status != 'done' LIMIT 1`);
  for (const p of heavyProjects(view)) {
    const id = projects.find((x) => x.slug === p.slug)?.id;
    if (!id || seen.get(id, TITLES.ru, TITLES.en)) continue;
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: own,
      payload: { project: p.slug, title: TITLES[lang], description: WORDS[lang](p.main.path, p.main.chars, p.main.lines), status: 'backlog' } });
    if (res.statusCode >= 300) logError('server', 'automations', `health task of ${p.slug}: ${res.statusCode} ${res.body.slice(0, 200)}`);
  }
}

const WORK = ['prep', 'doing', 'ready', 'deploy'];
const within = (folder, cwd) => {
  const rel = relative(folder, cwd);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
/** The sessions at work in `folder` among the registry's entries ({cwd, alive, status}): their count. Pure. */
export function claudesAt(folder, entries) {
  let n = 0;
  for (const e of entries) if (e.cwd && within(folder, e.cwd) && !['gone', 'idle'].includes(stateOf(e))) n += 1;
  return n;
}
const real = async (p) => { try { return await realpath(p); } catch { return p; } };

/** What holds a fix of the project's CLAUDE.md now: {sessions, keys} — nothing held when both are empty. */
export async function fixHolds(project, registry = readRegistry) {
  const folder = await real(project.path);
  const entries = await Promise.all([...(await registry()).values()].map(async (e) => ({ ...e, cwd: e.cwd ? await real(e.cwd) : null })));
  const keys = db.prepare(`SELECT p.prefix || '-' || t.task_no AS key FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.status IN (${WORK.map(() => '?').join(', ')}) AND ${noclaudeFilter('t.')} ORDER BY t.task_no`)
    .all(project.id, ...WORK).map((r) => r.key);
  return { sessions: claudesAt(folder, entries), keys };
}

/** The open task «Shrink CLAUDE.md» of each project, the newest: {slug: {id, key, status}}. Read on every look — no walk. */
export function openFixes() {
  const rows = db.prepare(`SELECT p.slug, t.id, p.prefix || '-' || t.task_no AS key, t.status FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND t.title IN (?, ?) AND t.status NOT IN ('done', 'cancelled') ORDER BY t.id`).all(TITLES.ru, TITLES.en);
  const out = {};
  for (const r of rows) out[r.slug] = { id: r.id, key: r.key, status: r.status }; // the newest wins
  return out;
}

const fixing = new Map(); // slug → the press in flight
/** The task of «Fix» for a project: one still open of the same title (backlog → To do), else a new one in To do.
    {key, created} or {code, error, reason, …} of a refusal. */
export function healthFixTask(app, slug, registry) {
  const key = String(slug || '');
  const run = (fixing.get(key) || Promise.resolve()).then(() => fixOnce(app, key, registry));
  const done = run.catch(() => {});
  fixing.set(key, done);
  done.then(() => { if (fixing.get(key) === done) fixing.delete(key); });
  return run;
}
async function fixOnce(app, slug, registry) {
  const p = db.prepare('SELECT id, slug, name, path, category, archived FROM projects WHERE slug = ?').get(slug);
  if (!p) return { code: 404, error: 'project not found' };
  if (p.archived) return { code: 400, error: 'the project is archived' };
  const view = await healthView([p]);
  const h = view.projects[0];
  if (!p.path || h.folder === null || h.missing) return { code: 409, reason: 'no-folder', error: 'the project has no folder on this computer — set it in the project' };
  if (!h.main) return { code: 409, reason: 'no-claude-md', error: 'the project has no CLAUDE.md of its own' };
  if (!fixable(h.main, view.norms)) return { code: 409, reason: 'within-norm', error: 'the CLAUDE.md of this project is within the norms — there is nothing to fix' };
  const held = await fixHolds(p, registry);
  if (held.sessions || held.keys.length) return { code: 409, reason: 'busy', error: 'Claude works in the folder of this project — fix it once the work there is over', ...held };
  const open = db.prepare(`SELECT p.prefix || '-' || t.task_no AS key, t.status FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ? AND t.title IN (?, ?) AND t.status NOT IN ('done', 'cancelled') ORDER BY t.id DESC LIMIT 1`).get(p.id, TITLES.ru, TITLES.en);
  if (open?.status === 'review') return { code: 409, reason: 'review', key: open.key, error: 'the last fix of this CLAUDE.md waits for your review' };
  if (open) {
    if (open.status === 'backlog') {
      const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${encodeURIComponent(open.key)}`, headers: own, payload: { status: 'todo' } });
      if (res.statusCode >= 300) return { code: res.statusCode, error: res.json?.().error || 'could not move the task to To do' };
    }
    return { key: open.key, created: false };
  }
  const lang = uiLang() === 'en' ? 'en' : 'ru';
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: own,
    payload: { project: p.slug, title: TITLES[lang], description: WORDS[lang](h.main.path, h.main.chars, h.main.lines, WORDS.button[lang]), status: 'todo' } });
  if (res.statusCode >= 300) return { code: res.statusCode, error: res.json().error || 'could not open the task' };
  return { key: res.json().key, created: true };
}
