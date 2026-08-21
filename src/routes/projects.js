import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { db, DATA_DIR, genPrefix, usedPrefixes, makePrefix, kvGet, kvSet, logError } from '../db.js';
import { localRoot, panelUrl, panelInfo } from '../config.js';
import { emit } from '../bus.js';
import { forgetRepoBase } from '../repo-base.js';
import { parsePm2Services, serializePm2Services } from '../pm2-services.js';
import { GENERIC_DEPLOY_SKILL, SKILL_NAME_RE, resolveSkillPath, skillInfo } from '../skills.js';
import { snapshotFile } from '../file-snapshot.js';

const DEFAULT_CATEGORY = 'Other';
const LOCKED_CATEGORIES = new Set([DEFAULT_CATEGORY, 'Local']);
function extraCategories() {
  try {
    const v = JSON.parse(kvGet('ui.categories') || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}
function setExtraCategories(list) {
  kvSet('ui.categories', JSON.stringify([...new Set(list)]));
}
function categoryNames() {
  const rows = db.prepare('SELECT DISTINCT COALESCE(NULLIF(category, \'\'), ?) AS cat FROM projects').all(DEFAULT_CATEGORY);
  return [...new Set([...rows.map((r) => r.cat), ...extraCategories()])];
}

function scanFolders() {
  let dirs;
  try {
    dirs = readdirSync(localRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch { return { root: localRoot(), unregistered: [], missing: [] }; }
  const projects = db.prepare('SELECT slug, name, path, archived FROM projects').all();
  const underRoot = projects.filter((p) => p.path && p.path.startsWith(`${localRoot()}/`));
  const registered = new Set(underRoot.map((p) => basename(p.path)));
  const unregistered = dirs.filter((name) => !registered.has(name));
  const missing = underRoot
    .filter((p) => !p.archived && !existsSync(p.path))
    .map((p) => ({ slug: p.slug, name: p.name, path: p.path }));
  return { root: localRoot(), unregistered, missing };
}

function syncCategoryToPanel(project) {
  if (!panelInfo()) return;
  try {
    const services = parsePm2Services(project.pm2_services);
    if (!services.length || !existsSync(panelInfo())) return;
    const info = JSON.parse(readFileSync(panelInfo(), 'utf8'));
    let changed = false;
    for (const name of services) {
      if (info[name] && info[name].category !== project.category) {
        info[name].category = project.category;
        changed = true;
      }
    }
    if (changed) writeFileSync(panelInfo(), JSON.stringify(info, null, 2) + '\n');
  } catch {  }
}

const PATCHABLE = ['name', 'prefix', 'path', 'server_path', 'deploy_skill', 'server', 'pm2_services', 'domain', 'category', 'description', 'pinned', 'archived'];

const FIELD_KIND = { pinned: 'flag', archived: 'flag', pm2_services: 'any' };
function badField(k, v) {
  const kind = FIELD_KIND[k] || 'text';
  if (kind === 'any') return null;
  if (kind === 'flag') {
    if (v === null || v === undefined) return `${k}: expected 0 or 1`;
    if (typeof v === 'boolean' || v === 0 || v === 1 || v === '0' || v === '1') return null;
    return `${k}: expected 0 or 1`;
  }
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return null;
  return `${k}: expected a string`;
}
const normField = (k, v) => {
  if (FIELD_KIND[k] === 'flag') return (v === true || v === 1 || v === '1') ? 1 : 0;
  if (FIELD_KIND[k] === 'any') return v;
  return v === null ? null : String(v);
};

export function projectBySlug(slug) {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
}

function checkPrefix(raw, selfId) {
  const pref = String(raw).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(pref)) return { error: 'prefix: 2-10 latin letters or digits' };
  const clash = db.prepare('SELECT id FROM projects WHERE upper(prefix) = ? AND id != COALESCE(?, -1)').get(pref, selfId ?? null);
  if (clash) return { error: 'prefix is taken by another project' };
  return { pref };
}

export function resolveProject(key) {
  if (!key) return null;
  return projectBySlug(key)
    || db.prepare('SELECT * FROM projects WHERE upper(prefix) = upper(?)').get(key);
}

let panelCache = { at: 0, data: null };

async function remoteStats() {
  const res = await fetch(panelUrl(), { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  const clean = text.replace(new RegExp('[\\u0000-\\u001f]', 'g'), (c) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : ''));
  const data = JSON.parse(clean);
  const list = Array.isArray(data) ? data : data.pm2 || [];
  return list.map((x) => ({
    name: x.name, status: x.status, uptime: x.uptime,
    restarts: x.restarts, memory: x.rssTotal ?? x.memory ?? 0, cpu: x.cpu ?? 0,
  }));
}

function localPm2Stats() {
  return new Promise((resolve, reject) => {
    execFile('pm2', ['jlist'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        return reject(new Error(err.code === 'ENOENT'
          ? 'no status source configured: local pm2 was not found and KB_PANEL_URL is not set'
          : `pm2 jlist: ${String(err.message).slice(0, 120)}`));
      }
      try {
        const raw = stdout.slice(stdout.indexOf('['));
        resolve(JSON.parse(raw).map((p) => ({
          name: p.name, status: p.pm2_env?.status, uptime: p.pm2_env?.pm_uptime,
          restarts: p.pm2_env?.restart_time, memory: p.monit?.memory || 0, cpu: p.monit?.cpu || 0,
        })));
      } catch (e) { reject(new Error(`pm2 jlist: could not parse the output (${e.message})`)); }
    });
  });
}

async function serviceStats() {
  if (Date.now() - panelCache.at < 30000) return panelCache.data;
  const data = panelUrl() ? await remoteStats() : await localPm2Stats();
  panelCache = { at: Date.now(), data };
  return data;
}

export default async function projectRoutes(app) {
  app.get('/api/projects', () => {
    return db.prepare(`
      SELECT p.*,
        SUM(CASE WHEN t.status='backlog'   THEN 1 ELSE 0 END) AS c_backlog,
        SUM(CASE WHEN t.status='todo'      THEN 1 ELSE 0 END) AS c_todo,
        SUM(CASE WHEN t.status='prep'      THEN 1 ELSE 0 END) AS c_prep,
        SUM(CASE WHEN t.status='doing'     THEN 1 ELSE 0 END) AS c_doing,
        SUM(CASE WHEN t.status='deploy'    THEN 1 ELSE 0 END) AS c_deploy,
        SUM(CASE WHEN t.status='review'    THEN 1 ELSE 0 END) AS c_review,
        SUM(CASE WHEN t.status='done'      THEN 1 ELSE 0 END) AS c_done,
        SUM(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) AS c_cancelled,
        SUM(CASE WHEN t.blocked=1 AND t.status NOT IN ('done','cancelled') THEN 1 ELSE 0 END) AS c_blocked
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.archived = 0
      GROUP BY p.id
      ORDER BY p.position, p.name COLLATE NOCASE
    `).all();
  });

  app.get('/api/projects/archived', () => db.prepare(`
    SELECT p.slug, p.name, p.category, p.archived,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_n
    FROM projects p WHERE p.archived = 1 ORDER BY p.name COLLATE NOCASE
  `).all());

  app.post('/api/projects/reorder', (req, reply) => {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : null;
    if (!slugs) return reply.code(400).send({ error: 'slugs[] required' });
    if (slugs.some((s) => typeof s !== 'string')) return reply.code(400).send({ error: 'slugs[]: expected strings' });
    const upd = db.prepare('UPDATE projects SET position = ? WHERE slug = ?');
    const tx = db.transaction((list) => list.forEach((s, i) => upd.run(i, s)));
    tx(slugs);
    return { ok: true };
  });

  app.get('/api/categories', () => {
    const rows = db.prepare(`SELECT COALESCE(NULLIF(category, ''), ?) AS cat, COUNT(*) AS count
      FROM projects WHERE archived = 0
      GROUP BY COALESCE(NULLIF(category, ''), ?)
      ORDER BY MIN(position), MIN(name) COLLATE NOCASE`).all(DEFAULT_CATEGORY, DEFAULT_CATEGORY);
    const list = rows.map((r) => ({ name: r.cat, count: r.count, locked: LOCKED_CATEGORIES.has(r.cat) }));
    const have = new Set(rows.map((r) => r.cat));
    for (const name of extraCategories()) {
      if (!have.has(name)) list.push({ name, count: 0, locked: LOCKED_CATEGORIES.has(name) });
    }
    return list;
  });

  app.post('/api/categories', (req, reply) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name.length > 40) return reply.code(400).send({ error: 'category name: up to 40 characters' });
    if (categoryNames().includes(name)) return reply.code(409).send({ error: 'that category already exists' });
    setExtraCategories([...extraCategories(), name]);
    emit('category.updated', { name });
    return { ok: true, name };
  });

  app.patch('/api/categories/:name', (req, reply) => {
    const from = req.params.name;
    const to = String(req.body?.name || '').trim();
    if (!to) return reply.code(400).send({ error: 'name required' });
    if (to.length > 40) return reply.code(400).send({ error: 'category name: up to 40 characters' });
    if (LOCKED_CATEGORIES.has(from)) return reply.code(400).send({ error: `the "${from}" category cannot be renamed` });
    if (!categoryNames().includes(from)) return reply.code(404).send({ error: 'category not found' });
    if (to !== from && categoryNames().includes(to)) return reply.code(409).send({ error: 'that category already exists' });
    db.prepare('UPDATE projects SET category = ?, updated_at = datetime(\'now\') WHERE category = ?').run(to, from);
    setExtraCategories(extraCategories().map((c) => (c === from ? to : c)));
    emit('category.updated', { name: to, from });
    return { ok: true, name: to };
  });

  app.delete('/api/categories/:name', (req, reply) => {
    const name = req.params.name;
    if (LOCKED_CATEGORIES.has(name)) return reply.code(400).send({ error: `the "${name}" category cannot be deleted` });
    if (!categoryNames().includes(name)) return reply.code(404).send({ error: 'category not found' });
    db.prepare('UPDATE projects SET category = NULL, updated_at = datetime(\'now\') WHERE category = ?').run(name);
    setExtraCategories(extraCategories().filter((c) => c !== name));
    emit('category.updated', { name, removed: true });
    return { ok: true };
  });

  app.get('/api/projects/folders', () => scanFolders());

  const FS_LIMIT = 500;
  app.get('/api/fs', (req, reply) => {
    const raw = req.query?.path;
    if (raw !== undefined && typeof raw !== 'string') return reply.code(400).send({ error: 'path: expected a string' });
    const dir = raw ? resolve(String(raw).replace(/^~(?=$|\/)/, homedir())) : localRoot();
    let st;
    try { st = statSync(dir); } catch { return reply.code(404).send({ error: 'no such folder' }); }
    if (!st.isDirectory()) return reply.code(400).send({ error: 'not a folder' });
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return reply.code(403).send({ error: `cannot read the folder: ${e.code || e.message}` }); }
    const dirs = names.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
    const parent = resolve(dir, '..');
    return {
      path: dir,
      parent: parent === dir ? null : parent,
      dirs: dirs.slice(0, FS_LIMIT),
      truncated: dirs.length > FS_LIMIT,
      home: homedir(),
      root: localRoot(),
    };
  });

  const PICKERS = {
    darwin: ['osascript', ['-e', 'tell application "System Events" to activate', '-e', 'POSIX path of (choose folder with prompt "Choose the project folder")']],
    linux: ['zenity', ['--file-selection', '--directory', '--title=Choose the project folder']],
  };
  app.post('/api/fs/pick', async (req, reply) => {
    const spec = PICKERS[process.platform];
    if (!spec) return reply.code(501).send({ error: `no folder dialog on ${process.platform}` });
    const [cmd, args] = spec;
    const res = await new Promise((done) => {
      execFile(cmd, args, { timeout: 180000 }, (err, out, errOut) => done({ err, out: String(out || '').trim(), errOut: String(errOut || '') }));
    });
    if (res.err) {
      if (!res.out) return { path: null, cancelled: true };
      return reply.code(500).send({ error: res.errOut.trim() || res.err.message });
    }
    return { path: res.out || null, cancelled: !res.out };
  });

  app.post('/api/projects/folders', (req, reply) => {
    const raw = req.body?.name;
    if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      return reply.code(400).send({ error: 'name: expected a string' });
    }
    const name = String(raw ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
      return reply.code(400).send({ error: 'folder name: latin letters, digits, - and _, no slashes' });
    }
    const dir = join(localRoot(), name);
    const existed = existsSync(dir);
    if (!existed) {
      try { mkdirSync(dir, { recursive: true }); } catch (e) {
        logError('server', 'POST /api/projects/folders', `mkdir failed: ${e.message}`, dir);
        return reply.code(500).send({ error: `mkdir failed: ${e.message}` });
      }
    }
    if (db.prepare('SELECT slug FROM projects WHERE path = ?').get(dir)) {
      return reply.code(409).send({ error: 'folder is already on the board' });
    }
    if (projectBySlug(name)) return reply.code(409).send({ error: 'slug is taken' });
    db.prepare("INSERT INTO projects (slug, name, prefix, path, category) VALUES (?,?,?,?,'Local')")
      .run(name, name, makePrefix(name), dir);
    const p = projectBySlug(name);
    emit('project.updated', p);
    return reply.code(201).send({ ...p, created: !existed });
  });

  function badDeploySkill(body) {
    const ds = body?.deploy_skill;
    if (ds === undefined || ds === null || ds === '') return null;
    if (SKILL_NAME_RE.test(String(ds))) return null;
    return 'deploy_skill: the skill name only (latin letters, digits, hyphen, underscore), no paths';
  }

  app.get('/api/projects/:slug', (req, reply) => {
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { ...p, deploy_skill_path: resolveSkillPath(p.deploy_skill) };
  });

  const PROJECT_DOCS = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'README.md', 'ARCHITECTURE.md'];
  const DOC_MAX_BYTES = 512 * 1024;
  function docPath(project, name) {
    if (!project?.path || !PROJECT_DOCS.includes(name)) return null;
    const base = resolve(project.path);
    const p = resolve(base, name);
    return p.startsWith(base + sep) ? p : null;
  }

  app.get('/api/projects/:slug/docs', (req, reply) => {
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const docs = PROJECT_DOCS.map((name) => {
      const path = docPath(p, name);
      let st = null;
      try { st = path ? statSync(path) : null; } catch {  }
      return { name, path, exists: Boolean(st?.isFile()), size: st?.size ?? null, mtime: st ? new Date(st.mtimeMs).toISOString() : null };
    })
      .filter((d) => d.exists || d.name === 'CLAUDE.md');
    const skill = p.deploy_skill ? skillInfo(p.deploy_skill) : null;
    return {
      path: p.path || null,
      path_exists: Boolean(p.path && existsSync(p.path)),
      docs,
      skill: skill && { ...skill, generic: p.deploy_skill === GENERIC_DEPLOY_SKILL },
    };
  });

  function docRealPath(path) {
    try { return realpathSync(path); } catch {  }
    try { return join(realpathSync(join(path, '..')), path.split(sep).pop()); } catch { return path; }
  }

  app.get('/api/projects/:slug/docs/:name', (req, reply) => {
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const path = docPath(p, req.params.name);
    if (!path) return reply.code(400).send({ error: 'unknown document' });
    let buf;
    try { buf = readFileSync(path); } catch { return reply.code(404).send({ error: 'the file is not there' }); }
    return {
      name: req.params.name,
      path,
      real_path: docRealPath(path),
      text: buf.subarray(0, DOC_MAX_BYTES).toString('utf8'),
      truncated: buf.length > DOC_MAX_BYTES,
    };
  });

  app.put('/api/projects/:slug/docs/:name', (req, reply) => {
    if (process.env.KB_PREVIEW_TTL_MS) return reply.code(403).send({ error: 'this is a check board opened from a backup — it does not write files' });
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const path = docPath(p, req.params.name);
    if (!path) return reply.code(400).send({ error: 'unknown document' });
    const text = req.body?.text;
    if (typeof text !== 'string') return reply.code(400).send({ error: 'text is required' });
    if (Buffer.byteLength(text) > DOC_MAX_BYTES) return reply.code(413).send({ error: `the file is larger than ${Math.round(DOC_MAX_BYTES / 1024)} KB` });
    if (!existsSync(p.path)) return reply.code(400).send({ error: 'the project folder is not there' });
    const real = docRealPath(path);
    if (req.body?.confirm_path !== real) {
      return reply.code(409).send({ error: 'the file on disk is not the one the page was editing', real_path: real });
    }
    const backup = snapshotFile('docs', `${p.slug}-${req.params.name}`, path);
    writeFileSync(path, text);
    const st = statSync(path);
    return { name: req.params.name, path, real_path: real, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), backup, backup_name: backup ? backup.split(sep).pop() : null };
  });

  app.get('/api/projects/:slug/status', async (req, reply) => {
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const services = parsePm2Services(p.pm2_services);
    if (!services.length) return reply.code(404).send({ error: 'the project has no pm2 services' });
    let stats;
    try {
      stats = await serviceStats();
    } catch (e) {
      return reply.code(502).send({ error: panelUrl() ? `status source (${panelUrl()}) is unavailable: ${e.message}` : e.message });
    }
    return services.map((name) => {
      const proc = stats.find((x) => x.name === name);
      if (!proc) return { name, status: 'not found' };
      return {
        name,
        status: proc.status,
        uptime_h: proc.uptime ? Math.round((Date.now() - proc.uptime) / 3600000) : null,
        restarts: proc.restarts,
        mem_mb: Math.round((proc.memory || 0) / 1048576),
        cpu: proc.cpu,
      };
    });
  });

  app.post('/api/projects/clone', async (req, reply) => {
    const url = String(req.body?.url || '').trim();
    let name = String(req.body?.name || '').trim();
    if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url)) return reply.code(400).send({ error: 'git URL: https://… or git@…' });
    if (!name) name = url.split('/').pop().replace(/\.git$/, '');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return reply.code(400).send({ error: 'folder name: latin letters, digits, - and _' });
    const dir = join(localRoot(), name);
    if (existsSync(dir)) return reply.code(409).send({ error: `folder ${name} already exists in ${localRoot()}` });
    try {
      await new Promise((resolve, reject) => execFile('git', ['clone', '--', url, dir], {
        timeout: 180000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      }, (err, _out, serr) => (err ? reject(new Error(String(serr || err.message).slice(0, 300))) : resolve())));
    } catch (e) { return reply.code(502).send({ error: `git clone: ${e.message}` }); }
    return { path: dir, name };
  });

  app.post('/api/projects/server-git', async (req, reply) => {
    const server = String(req.body?.server || '').trim();
    const path = String(req.body?.path || '').trim();
    if (!server || !path) return reply.code(400).send({ error: 'server and path are required' });
    if (!/^[\w.@][\w.@-]*$/.test(server)) return reply.code(400).send({ error: 'server: an ssh alias or host, no options or spaces' });
    if (/["'`;|&$\\]/.test(path)) return reply.code(400).send({ error: 'path: invalid characters' });
    const sshRun = (cmd) => new Promise((resolve) => execFile('ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', server, cmd],
      { timeout: 20000 }, (err, out, serr) => resolve({ err, out: String(out || '').trim(), serr: String(serr || '').trim() })));
    const dirCheck = await sshRun(`test -d "${path}" && echo yes`);
    if (dirCheck.out !== 'yes') {
      return reply.code(502).send({ error: `ssh/directory: ${dirCheck.serr || `no ${path} directory, or no access to ${server}`}` });
    }
    if (req.body?.init) {
      const r = await sshRun(`git -C "${path}" init`);
      if (r.err) return reply.code(502).send({ error: `git init: ${r.serr || 'failed'}` });
      return { git: true, initialized: true };
    }
    const r = await sshRun(`git -C "${path}" rev-parse --is-inside-work-tree`);
    return { git: !r.err && r.out === 'true' };
  });

  const DEMO_TEXTS = {
    ru: {
      name: 'Демо-проект',
      about: 'Пример: как выглядит доска в работе. Удаляется в настройках проекта.',
      rows: [
        ['Идея из бэклога', 'Сюда падают все идеи. Кнопка копирования на колонке «Бэклог» копирует промпт для разбора бэклога Claude-ом.', 'backlog', 0, '[]', 0],
        ['Задача с чек-листом', 'Открой карточку — под описанием чек-лист. Пункты добавляются иконкой в правом углу описания.', 'backlog', 1, '["enhancement"]', 0],
        ['Готова к работе', 'Колонка «Сделать» — очередь для Claude: kb take возьмёт следующую отсюда. Кнопка копирования копирует готовый промпт.', 'todo', 3, '["feature"]', 0],
        ['Связанная задача', 'Связи рисуются линией на доске (меню ⋯ в карточке → «Связать»). Эта связана со следующей.', 'todo', 2, '["ui"]', 0],
        ['На проверке', 'Claude доводит задачу до «Проверяю» и останавливается — принимает или возвращает человек.', 'review', 2, '["bug"]', 1800],
        ['Уже готова', 'Принятые задачи копятся в «Готово» и считаются в метриках дашборда.', 'done', 1, '[]', 3600],
      ],
      checklist: ['посмотреть колонки доски', 'открыть карточку и таймлайн', 'удалить демо, когда надоест'],
    },
    en: {
      name: 'Demo project',
      about: 'An example of the board at work. Delete it any time in the project settings.',
      rows: [
        ['An idea in the backlog', 'All ideas land here. The copy button on the Backlog column copies a grooming prompt for Claude.', 'backlog', 0, '[]', 0],
        ['Task with a checklist', 'Open the card — there is a checklist under the description. Add items with the icon in the top-right corner of the description.', 'backlog', 1, '["enhancement"]', 0],
        ['Ready to work on', 'The To do column is Claude\'s queue: kb take picks the next task from here. The copy button copies a ready-made prompt.', 'todo', 3, '["feature"]', 0],
        ['A linked task', 'Links are drawn as lines on the board (card menu ⋯ → Link). This one is linked to the next task.', 'todo', 2, '["ui"]', 0],
        ['In review', 'Claude takes a task up to Review and stops — accepting or returning it is always up to the human.', 'review', 2, '["bug"]', 1800],
        ['Already done', 'Accepted tasks pile up in Done and feed the dashboard metrics.', 'done', 1, '[]', 3600],
      ],
      checklist: ['look through the board columns', 'open a card and its timeline', 'delete the demo when done with it'],
    },
  };

  app.post('/api/projects/demo', (req, reply) => {
    if (projectBySlug('demo')) return reply.code(409).send({ error: 'the demo project already exists' });
    const T = DEMO_TEXTS[req.body?.lang === 'en' ? 'en' : 'ru'];
    const used = usedPrefixes();
    const prefix = used.has('DEMO') ? genPrefix('demo', used) : 'DEMO';
    db.prepare("INSERT INTO projects (slug, name, prefix, category, description) VALUES ('demo', ?, ?, ?, ?)")
      .run(T.name, prefix, 'Other', T.about);
    const pid = projectBySlug('demo').id;
    const ins = db.prepare(`INSERT INTO tasks (project_id, task_no, title, description, status, priority, labels, done_at, work_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const doneAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const tx = db.transaction(() => {
      const ids = T.rows.map(([title, desc, status, pri, labels, work], i) =>
        ins.run(pid, i + 1, title, desc, status, pri, labels, status === 'done' ? doneAt : null, work).lastInsertRowid);
      db.prepare('UPDATE projects SET next_task_no = ? WHERE id = ?').run(T.rows.length + 1, pid);
      db.prepare("INSERT INTO task_links (task_id, linked_task_id, kind) VALUES (?, ?, 'related')")
        .run(Math.min(ids[2], ids[3]), Math.max(ids[2], ids[3]));
      const chk = db.prepare('INSERT INTO task_checklist (task_id, text, done, position) VALUES (?, ?, ?, ?)');
      T.checklist.forEach((text, i) => chk.run(ids[1], text, i === 0 ? 1 : 0, i + 1));
      db.prepare("INSERT INTO task_events (task_id, status, created_at) VALUES (?, 'done', datetime('now'))").run(ids[5]);
      db.prepare("INSERT INTO task_events (task_id, status, created_at) VALUES (?, 'review', datetime('now'))").run(ids[4]);
    });
    tx();
    const p = projectBySlug('demo');
    emit('project.updated', p);
    return reply.code(201).send(p);
  });

  app.delete('/api/projects/demo', (req, reply) => {
    const p = projectBySlug('demo');
    if (!p) return reply.code(404).send({ error: 'there is no demo project' });
    const ids = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(p.id).map((t) => t.id);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    for (const id of ids) rmSync(join(DATA_DIR, 'attachments', String(id)), { recursive: true, force: true });
    emit('project.updated', { slug: 'demo', deleted: true });
    return { ok: true };
  });

  app.post('/api/projects', (req, reply) => {
    const { slug, name } = req.body || {};
    if (!slug || !name) return reply.code(400).send({ error: 'slug and name required' });
    if (typeof slug !== 'string' || typeof name !== 'string') {
      return reply.code(400).send({ error: 'slug and name: expected strings' });
    }
    if (projectBySlug(slug)) return reply.code(409).send({ error: 'slug exists' });
    const dsErr = badDeploySkill(req.body);
    if (dsErr) return reply.code(400).send({ error: dsErr });
    const fields = { slug, name, prefix: makePrefix(slug) };
    for (const k of PATCHABLE) {
      if (req.body[k] === undefined) continue;
      const bad = badField(k, req.body[k]);
      if (bad) return reply.code(400).send({ error: bad });
      fields[k] = normField(k, req.body[k]);
    }
    // The field is documented as "comma-separated string <-> JSON", so store the canonical
    // form instead of whatever the caller sent (readers stay tolerant for older rows).
    if (fields.pm2_services !== undefined) fields.pm2_services = serializePm2Services(fields.pm2_services);
    const pc = checkPrefix(fields.prefix, null);
    if (pc.error) return reply.code(400).send({ error: pc.error });
    fields.prefix = pc.pref;
    const cols = Object.keys(fields);
    db.prepare(`INSERT INTO projects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((k) => fields[k]));
    const p = projectBySlug(slug);
    emit('project.updated', p);
    return reply.code(201).send(p);
  });

  app.patch('/api/projects/:slug', (req, reply) => {
    const p = resolveProject(req.params.slug);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const dsErr = badDeploySkill(req.body);
    if (dsErr) return reply.code(400).send({ error: dsErr });
    if (req.body?.prefix !== undefined) {
      const pc = checkPrefix(req.body.prefix, p.id);
      if (pc.error) return reply.code(400).send({ error: pc.error });
      req.body.prefix = pc.pref;
    }
    const updates = [];
    const values = [];
    for (const k of PATCHABLE) {
      if (req.body && req.body[k] !== undefined) {
        const bad = badField(k, req.body[k]);
        if (bad) return reply.code(400).send({ error: bad });
        updates.push(`${k} = ?`);
        values.push(k === 'pm2_services' ? serializePm2Services(req.body[k]) : normField(k, req.body[k]));
      }
    }
    if (updates.length) {
      values.push(p.id);
      db.prepare(`UPDATE projects SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
    }
    const fresh = resolveProject(req.params.slug);
    if (req.body?.path !== undefined && req.body.path !== p.path) {
      forgetRepoBase(p.path);
      forgetRepoBase(fresh.path);
    }
    if (req.body?.category !== undefined && req.body.category !== p.category) syncCategoryToPanel(fresh);
    emit('project.updated', fresh);
    return fresh;
  });
}
