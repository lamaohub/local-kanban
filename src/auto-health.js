import { PORT } from './config.js';
import { db, kvGet, kvSet, logError, uiLang } from './db.js';
import { NORMS, healthView } from './health.js';

export const HEALTH_SWITCH = 'automations.health';
const LAST_KEY = 'automations.health.last';
export const HEALTH_EVERY_MS = 24 * 3600_000;
const own = { host: `127.0.0.1:${PORT}` };
const TITLES = { ru: 'Ужать CLAUDE.md', en: 'Shrink CLAUDE.md' };
const fmt = (n) => n.toLocaleString('ru-RU');
const WORDS = {
  ru: (file, chars) => `${file}: ${fmt(chars)} знаков при норме ${fmt(NORMS.file_chars)}. Claude Code предупреждает об этом на старте и хуже следует таким инструкциям. Подробности разнести по правилам .claude/rules/<тема>.md с paths:, в файле оставить общее.\n\nЗадачу завела доска: раздел «Здоровье», автоматизация.`,
  en: (file, chars) => `${file}: ${fmt(chars)} characters, the norm is ${fmt(NORMS.file_chars)}. Claude Code warns about it at the start and follows such instructions worse. Move the details to rules .claude/rules/<topic>.md with paths:, and keep what is common in the file.\n\nThe board opened this task: the Health section, an automation.`,
};

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
      payload: { project: p.slug, title: TITLES[lang], description: WORDS[lang](p.main.path, p.main.chars), status: 'backlog' } });
    if (res.statusCode >= 300) logError('server', 'automations', `health task of ${p.slug}: ${res.statusCode} ${res.body.slice(0, 200)}`);
  }
}
