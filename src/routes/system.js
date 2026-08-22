import { execFile } from 'node:child_process';
import { statSync, readdirSync, createReadStream, createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, kvGet, kvSet, ghOwner, ghRepo, syncConfigured, enqueue, logError, uiLang, SYNC_MAX_ATTEMPTS } from '../db.js';
import { emit } from '../bus.js';
import { ghState, kick, syncPaused } from '../sync/worker.js';
import { LABELS, MANAGED_LABELS, gh as ghCli } from '../sync/github.js';
import { listBackups, backupNow, backupPath, backupState, ATTACH_MIRROR } from '../backup.js';
import { inspectBackup, startPreview, stopPreview, currentPreview } from '../restore.js';
import { langOverride, ghOwnerEnv, ghRepoEnv } from '../config.js';
import { snapshot, TASK_SELECT } from './tasks.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PACKAGED = ROOT_DIR.split(sep).includes('node_modules');

let selfPkgCache;
function selfPkg() {
  if (selfPkgCache === undefined) {
    try {
      const { name, version, repository } = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
      selfPkgCache = name && version ? { name, version, repository: repository?.url || repository || null } : null;
    } catch { selfPkgCache = null; }
  }
  return selfPkgCache;
}

export function isNewer(candidate, current) {
  const nums = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [nums(candidate), nums(current)];
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

export function updatePlan({ packaged, name, root }) {
  if (!packaged) return { how: 'git', cmd: 'git', args: ['pull', '--ff-only'] };
  const args = ['install', '-g', `${name}@latest`];
  const prefix = globalPrefixOf(root, name);
  if (prefix) args.push('--prefix', prefix);
  return { how: 'npm', cmd: 'npm', args };
}

export function globalPrefixOf(root, name) {
  const parts = String(root || '').split(sep).filter(Boolean);
  const tail = String(name || '').split('/').filter(Boolean);
  if (!tail.length || parts.length < tail.length + 3) return null;
  const own = parts.slice(-tail.length).join('/') === tail.join('/');
  const cut = parts.slice(0, -tail.length);
  if (!own || cut.at(-1) !== 'node_modules' || cut.at(-2) !== 'lib') return null;
  const prefix = cut.slice(0, -2).join(sep);
  return prefix ? (root.startsWith(sep) ? sep + prefix : prefix) : null;
}

const NPM_NOISE = /^npm error(\s+at\b|\s*[{}]|\s+A complete log of this run\b|\s+(errno|syscall|path|dest|stack|code|signal|cmd|args|file):)/i;
export function failureReason(output, fallback = '') {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /^(error\b|fatal:|npm error)/i.test(l));
  const pool = marked.filter((l) => !NPM_NOISE.test(l));
  const best = (pool.length ? pool : marked);
  const pick = best.length ? best.reduce((a, b) => (b.length > a.length ? b : a)) : lines.at(-1);
  return (pick || fallback || '').slice(0, 300);
}

export function restartMode(env = process.env) {
  return env.pm_id !== undefined && env.pm_id !== '' ? 'pm2' : 'manual';
}

export async function registryCheck() {
  const pkg = selfPkg();
  if (!pkg) return null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {
      headers: { 'User-Agent': 'local-kanban', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const remote = (await res.json())?.version;
    if (!remote) return null;
    return { update_available: isNewer(remote, pkg.version), local: pkg.version, remote, branch: null, tag: null, dev: null };
  } catch { return null; }
}

export async function ghApi(path) {
  try {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: { 'User-Agent': 'local-kanban', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
  } catch {  }
  try { return JSON.parse(await ghCli(['api', path], { timeout: 10000 })); }
  catch { return null; }
}

export function changelogSection(text, version) {
  const head = new RegExp(`^##\\s*\\[?${String(version).replace(/\./g, '\\.')}\\]?`, 'm');
  const m = head.exec(String(text || ''));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null;
}

export function repoSlug(url) {
  const m = String(url || '').match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const UPLOAD_FLOOR = 64 * 1024 * 1024;
function uploadLimit() {
  try { return Math.max(UPLOAD_FLOOR, statSync(join(DATA_DIR, 'kanban.db')).size * 4); } catch { return UPLOAD_FLOOR; }
}

export default async function systemRoutes(app) {
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => {
    const limit = uploadLimit();
    const file = join(tmpdir(), `kb-upload-${process.pid}-${Date.now()}.db`);
    const out = createWriteStream(file);
    let size = 0;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      payload.unpipe?.(out);
      out.destroy();
      rmSync(file, { force: true });
      done(err);
    };
    payload.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const e = new Error(`the file is larger than ${Math.round(limit / 1048576)} MB`);
        e.statusCode = 413;
        fail(e);
      }
    });
    payload.on('error', fail);
    out.on('error', fail);
    out.on('close', () => { if (!failed) done(null, { file, size }); });
    payload.pipe(out);
  });

  app.get('/api/labels', () => ({
    palette: Object.fromEntries(Object.entries(LABELS).map(([name, hex]) => [name, `#${hex}`])),
    selectable: Object.keys(LABELS).filter((name) => !MANAGED_LABELS.has(name)),
  }));

  app.get('/api/sync', () => {
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE attempts < ${SYNC_MAX_ATTEMPTS}`).get().n;
    const failed = db.prepare(`SELECT id, op, task_id, last_error FROM sync_queue WHERE attempts >= ${SYNC_MAX_ATTEMPTS}`).all();
    const errors = db.prepare(`
      SELECT q.id, q.op, q.attempts, q.last_error, q.created_at, t.task_no, p.prefix
      FROM sync_queue q
      LEFT JOIN tasks t ON t.id = q.task_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE q.last_error IS NOT NULL
      ORDER BY q.id DESC LIMIT 10
    `).all().map((r) => ({
      id: r.id, op: r.op, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at,
      key: r.prefix && r.task_no ? `${r.prefix}-${r.task_no}` : null,
    }));
    return {
      pending, failed, gh: ghState.available, errors, paused: syncPaused(), last_ok: kvGet('sync.last_ok'),
      configured: syncConfigured(), owner: ghOwner(), repo: ghRepo(),
      source: ghOwnerEnv() || ghRepoEnv() ? 'env' : (kvGet('gh.owner') || kvGet('gh.repo') ? 'kv' : null),
    };
  });

  app.post('/api/sync/config', (req, reply) => {
    const owner = String(req.body?.owner ?? '').trim();
    const repo = String(req.body?.repo ?? '').trim();
    const badGhName = (s) => !/^(?!-)[\w.-]{1,100}$/.test(s) || s === '.' || s === '..';
    if (owner && badGhName(owner)) {
      return reply.code(400).send({ error: 'owner: letters, digits and hyphens; cannot start with a hyphen' });
    }
    if (repo) {
      const parts = repo.split('/');
      if (parts.length !== 2 || parts.some(badGhName)) {
        return reply.code(400).send({ error: 'repo: expected owner/name' });
      }
    }
    const wasOn = syncConfigured();
    kvSet('gh.owner', owner);
    kvSet('gh.repo', repo);
    let backfilled = 0;
    if (!wasOn && syncConfigured()) {
      const rows = db.prepare(`${TASK_SELECT} WHERE t.gh_issue_number IS NULL AND t.status NOT IN ('done','cancelled')`).all();
      for (const t of rows) enqueue('create_issue', t.id, snapshot(t));
      backfilled = rows.length;
    }
    if (syncConfigured()) kick();
    emit('sync.status', { configured: syncConfigured() });
    return { configured: syncConfigured(), owner: ghOwner(), repo: ghRepo(), backfilled };
  });

  app.post('/api/sync/retry', () => {
    db.prepare("UPDATE sync_queue SET attempts = 0, next_attempt_at = datetime('now')").run();
    kick();
    return { ok: true };
  });

  app.post('/api/sync/pause', (req) => {
    const paused = !!req.body?.paused;
    kvSet('sync.paused', paused ? '1' : '0');
    if (!paused) kick();
    emit('sync.status', { paused });
    return { paused };
  });

  app.get('/api/errors', (req) => {
    const limit = Math.min(Number(req.query?.limit) || 100, 300);
    return db.prepare(
      'SELECT id, at, source, scope, message, substr(detail, 1, 300) AS detail, resolved_at, repeats FROM app_errors ORDER BY id DESC LIMIT ?',
    ).all(limit);
  });
  app.delete('/api/errors', () => { db.prepare('DELETE FROM app_errors').run(); return { ok: true }; });
  const clientErrSeen = new Map();
  const CLIENT_ERR_EVERY = 10000;
  app.post('/api/errors', (req, reply) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const now = Date.now();
    if (now - (clientErrSeen.get(message) || 0) < CLIENT_ERR_EVERY) return { ok: true, skipped: true };
    clientErrSeen.set(message, now);
    if (clientErrSeen.size > 200) {
      for (const [k, at] of clientErrSeen) if (now - at > CLIENT_ERR_EVERY) clientErrSeen.delete(k);
    }
    logError('client', req.body?.scope, message, req.body?.detail);
    return { ok: true };
  });

  const uiVersion = () => {
    const roots = [join(ROOT_DIR, 'public'), join(ROOT_DIR, 'public', 'js')];
    let newest = 0;
    for (const dir of roots) {
      let files = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.js')) continue;
        try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch {  }
      }
    }
    return newest;
  };
  app.get('/api/ui-version', () => ({ mtime: uiVersion() }));

  app.get('/api/about', async () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const stat = (p) => { try { return statSync(p); } catch { return null; } };
    const commit = await new Promise((resolve) => {
      execFile('git', ['log', '-1', '--format=%h %cs'], { cwd: ROOT }, (err, out) => resolve(err ? null : out.trim()));
    });
    const appMtime = uiVersion();
    const dbPath = join(DATA_DIR, 'kanban.db');
    return {
      commit,
      app_mtime: appMtime ? new Date(appMtime).toISOString() : null,
      db_path: dbPath,
      db_size: stat(dbPath)?.size ?? 0,
      uptime: Math.floor(process.uptime()),
      tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
      node: process.version,
      packaged: PACKAGED,
      version: selfPkg()?.version || null,
    };
  });

  const CACHE_OK_MS = 3600000;
  const CACHE_FAIL_MS = 60000;
  let updCache = { at: 0, ttl: 0, data: null };
  let lastForced = 0;
  const FORCE_EVERY = 15000;
  app.get('/api/update-check', async (req) => {
    const forced = Boolean(req.query?.refresh) && Date.now() - lastForced >= FORCE_EVERY;
    if (forced) lastForced = Date.now();
    if (!forced && updCache.data && Date.now() - updCache.at < updCache.ttl) return updCache.data;
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: ROOT, timeout: 8000 }, (err, out) => resolve(err ? null : out.trim()));
    });
    let data = { update_available: null, local: null, remote: null, branch: null, tag: null, dev: null };
    try {
      const [local, branch, origin, tag] = await Promise.all([
        git(['rev-parse', 'HEAD']),
        git(['rev-parse', '--abbrev-ref', 'HEAD']),
        git(['config', '--get', 'remote.origin.url']),
        git(['describe', '--tags', '--abbrev=0']),
      ]);
      const m = (origin || '').match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (local && branch && m) {
        const repo = `${m[1]}/${m[2]}`;
        const head = await ghApi(`repos/${repo}/commits/${branch}`);
        const remote = head?.sha || null;
        if (remote) data = { update_available: remote !== local, local: local.slice(0, 7), remote: remote.slice(0, 7), branch, tag, dev: null };
        else data = { ...data, branch, tag, local: local.slice(0, 7) };
        if (branch !== 'dev') {
          const cmp = await ghApi(`repos/${repo}/compare/${branch}...dev`);
          if (cmp && typeof cmp.ahead_by === 'number') {
            const tip = cmp.commits?.at(-1);
            data.dev = {
              ahead: cmp.ahead_by,
              sha: (tip?.sha || cmp.merge_base_commit?.sha || '').slice(0, 7) || null,
              date: tip?.commit?.committer?.date || null,
              message: (tip?.commit?.message || '').split('\n')[0].slice(0, 90) || null,
            };
          }
        }
      }
    } catch {  }
    if (data.update_available === null) data = (await registryCheck()) || data;
    updCache = { at: Date.now(), ttl: data.update_available === null ? CACHE_FAIL_MS : CACHE_OK_MS, data };
    return data;
  });

  const NEWS_OK_MS = 3600000;
  const NEWS_FAIL_MS = 60000;
  let newsCache = { at: 0, ttl: 0, data: null };
  app.get('/api/whats-new', async (req) => {
    const version = selfPkg()?.version || null;
    const own = () => {
      let text = null;
      try { text = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8'); } catch {  }
      return { version, notes: (text && version) ? changelogSection(text, version) : null, source: 'changelog', url: null };
    };
    if (!req.query?.remote) return own();
    if (!req.query?.refresh && newsCache.data && Date.now() - newsCache.at < newsCache.ttl) return newsCache.data;
    const repo = repoSlug(selfPkg()?.repository);
    const rel = repo ? await ghApi(`repos/${repo}/releases/latest`) : null;
    const tag = String(rel?.tag_name || '').replace(/^v/, '');
    const body = String(rel?.body || '').trim();
    const got = Boolean(tag && body);
    const data = got
      ? { version: tag, notes: body, source: 'github', url: rel.html_url || null }
      : own();
    newsCache = { at: Date.now(), ttl: got ? NEWS_OK_MS : NEWS_FAIL_MS, data };
    return data;
  });

  let updateRunning = null;
  app.post('/api/update', async (req, reply) => {
    if (updateRunning) return reply.code(409).send({ error: 'an update is already running' });
    const pkg = selfPkg();
    const plan = updatePlan({ packaged: PACKAGED, name: pkg?.name, root: ROOT_DIR });
    if (plan.how === 'npm' && !pkg?.name) return reply.code(500).send({ error: 'cannot tell which package to update' });

    const run = new Promise((resolve) => {
      execFile(plan.cmd, plan.args, { cwd: ROOT_DIR, timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
        (err, out, errOut) => resolve({ err, text: `${out || ''}${errOut || ''}`.trim() }));
    });
    updateRunning = run;
    let res;
    try { res = await run; } finally { if (updateRunning === run) updateRunning = null; }

    const output = res.text.slice(-2000);
    if (res.err) {
      logError('server', 'update', `update via ${plan.how} failed: ${res.err.message}`, output);

      return reply.code(500).send({
        ok: false, how: plan.how, output, cmd: [plan.cmd, ...plan.args].join(' '),
        error: failureReason(output, res.err.message),
      });
    }
    const restart = restartMode();
    if (restart === 'pm2') setTimeout(() => process.exit(0), 400).unref();
    updCache = { at: 0, ttl: 0, data: null };
    return { ok: true, how: plan.how, restart, output };
  });

  app.get('/api/lang', () => ({ lang: uiLang(), source: langOverride() ? 'env' : 'kv' }));
  app.post('/api/lang', (req) => {
    if (!langOverride()) kvSet('ui.lang', req.body?.lang === 'en' ? 'en' : 'ru');
    return { lang: uiLang() };
  });

  app.get('/api/onboarding', () => ({ done: kvGet('onboarding.done') === '1' }));
  app.post('/api/onboarding', (req) => {
    kvSet('onboarding.done', req.body?.done ? '1' : '0');
    return { done: kvGet('onboarding.done') === '1' };
  });

  app.get('/api/backups', () => ({
    items: listBackups(),
    last_ok: backupState.last_ok,
    last_error: backupState.last_error,
    last_error_at: backupState.last_error_at,
    attachments: existsSync(ATTACH_MIRROR),
  }));
  app.post('/api/backups', async () => { await backupNow(); return { ok: true }; });
  let uploading = false;
  app.post('/api/backups/restore', async (req, reply) => {
    const up = req.body;
    if (!up?.file || !up.size) {
      if (up?.file) rmSync(up.file, { force: true });
      return reply.code(400).send({ error: 'empty file' });
    }
    if (uploading) { rmSync(up.file, { force: true }); return reply.code(409).send({ error: 'another backup is already being opened' }); }
    uploading = true;
    try {
      const checked = inspectBackup(up.file);
      if (!checked.ok) return reply.code(400).send({ error: checked.error });
      try {
        const preview = await startPreview(checked.dir, checked.stats);
        return preview || reply.code(500).send({ error: 'the preview board failed to start' });
      } catch (e) {
        rmSync(checked.dir, { recursive: true, force: true });
        return reply.code(500).send({ error: `could not start the preview board: ${e.message}` });
      }
    } finally {
      rmSync(up.file, { force: true });
      uploading = false;
    }
  });
  app.get('/api/backups/restore', () => currentPreview() || { running: false });
  app.delete('/api/backups/restore', () => ({ stopped: stopPreview() }));

  app.get('/api/backups/:name', (req, reply) => {
    const path = backupPath(req.params.name);
    if (!path) return reply.code(404).send({ error: 'backup not found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${req.params.name}"`);
    return reply.send(createReadStream(path));
  });
}
