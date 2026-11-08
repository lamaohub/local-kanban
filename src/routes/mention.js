import { existsSync } from 'node:fs';
import { kvGet, kvSet } from '../db.js';
import { scalarQuery } from '../query-params.js';
import { resolveProject } from './projects.js';
import { FILES_SHOWN, projectFiles, rankFiles } from '../project-files.js';

export const TEMPLATES_MAX = 50;
export const TEMPLATE_NAME_RE = /^[^\s@]{1,40}$/u;
export const TEMPLATE_TEXT_MAX = 4000;

/** The templates of the request, or the reason they are refused. */
export function templatesProblem(list) {
  if (!Array.isArray(list)) return 'templates: a list of {name, text}';
  if (list.length > TEMPLATES_MAX) return `templates: at most ${TEMPLATES_MAX}`;
  const names = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || typeof t.text !== 'string') return 'templates: each is {name, text}, both text';
    if (!TEMPLATE_NAME_RE.test(t.name)) return `templates: a name is one word of up to 40 characters, without «@»: ${JSON.stringify(t.name).slice(0, 60)}`;
    if (t.text.length > TEMPLATE_TEXT_MAX || t.text.includes('\0')) return `templates: a text is at most ${TEMPLATE_TEXT_MAX} characters`;
    if (names.has(t.name.toLowerCase())) return `templates: the name ${t.name} is there twice`;
    names.add(t.name.toLowerCase());
  }
  return null;
}

export default async function mentionRoutes(app) {
  app.get('/api/templates', () => {
    let list = null;
    try { list = JSON.parse(kvGet('templates') || 'null'); } catch { list = null; }
    return { templates: Array.isArray(list) ? list : null };
  });
  // null — back to the defaults of the page
  app.put('/api/templates', (req, reply) => {
    const list = req.body?.templates;
    if (list !== null) {
      const problem = templatesProblem(list);
      if (problem) return reply.code(400).send({ error: problem, field: 'templates' });
    }
    kvSet('templates', JSON.stringify(list === null ? null : list.map(({ name, text }) => ({ name, text }))));
    return { templates: list };
  });
  app.get('/api/projects/:slug/files', async (req, reply) => {
    const q = scalarQuery(req.query, ['q', 'limit']);
    if (q.error) return reply.code(400).send({ error: q.error });
    const limit = q.values.limit === undefined ? FILES_SHOWN : Number(q.values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: 'limit: a whole number from 1 to 200' });
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (!p.path || !existsSync(p.path)) return { files: [], git: false, folder: false };
    const { files, git } = await projectFiles(p.path);
    return { files: rankFiles(files, q.values.q, limit), git, total: files.length };
  });
}
