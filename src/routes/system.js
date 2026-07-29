import { execFile } from 'node:child_process';
import { statSync, readdirSync, createReadStream } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, kvGet, kvSet, ghOwner, ghRepo, syncConfigured, enqueue, logError, uiLang, SYNC_MAX_ATTEMPTS } from '../db.js';
import { emit } from '../bus.js';
import { ghState, kick, syncPaused } from '../sync/worker.js';
import { LABELS, MANAGED_LABELS, gh as ghCli } from '../sync/github.js';
import { listBackups, backupNow, backupPath } from '../backup.js';
import { inspectBackup, startPreview, stopPreview, currentPreview } from '../restore.js';
import { langOverride, ghOwnerEnv, ghRepoEnv } from '../config.js';
import { snapshot, TASK_SELECT } from './tasks.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default async function systemRoutes(app) {
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
      'SELECT id, at, source, scope, message, substr(detail, 1, 300) AS detail, resolved_at FROM app_errors ORDER BY id DESC LIMIT ?',
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
      packaged: ROOT.split(sep).includes('node_modules'),
    };
  });

  let updCache = { at: 0, data: null };
  let lastForced = 0;
  const FORCE_EVERY = 15000;
  app.get('/api/update-check', async (req) => {
    const forced = Boolean(req.query?.refresh) && Date.now() - lastForced >= FORCE_EVERY;
    if (forced) lastForced = Date.now();
    if (!forced && updCache.data && Date.now() - updCache.at < 3600000) return updCache.data;
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: ROOT, timeout: 8000 }, (err, out) => resolve(err ? null : out.trim()));
    });
    const ghApi = async (path) => {
      try {
        const res = await fetch(`https://api.github.com/${path}`, {
          headers: { 'User-Agent': 'local-kanban', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return await res.json();
      } catch {  }
      try { return JSON.parse(await ghCli(['api', path], { timeout: 10000 })); }
      catch { return null; }
    };
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
    updCache = { at: Date.now(), data };
    return data;
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

  app.get('/api/backups', () => listBackups());
  app.post('/api/backups', async () => { await backupNow(); return { ok: true }; });
  app.post('/api/backups/restore', async (req, reply) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ error: 'empty file' });
    const checked = inspectBackup(buf);
    if (!checked.ok) return reply.code(400).send({ error: checked.error });
    try {
      const preview = await startPreview(checked.dir, checked.stats);
      return preview || reply.code(500).send({ error: 'the preview board failed to start' });
    } catch (e) {
      return reply.code(500).send({ error: `could not start the preview board: ${e.message}` });
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
