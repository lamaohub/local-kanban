import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, readdirSync, createReadStream, createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, kvGet, kvSet, ghOwner, ghRepo, syncConfigured, enqueue, logError, clearErrors, uiLang, SYNC_MAX_ATTEMPTS } from '../db.js';
import { emit } from '../bus.js';
import { ghState, kick, syncPaused } from '../sync/worker.js';
import { LABELS, MANAGED_LABELS, gh as ghCli } from '../sync/github.js';
import { listBackups, backupNow, backupPath, backupState, ATTACH_MIRROR } from '../backup.js';
import { inspectBackup, startPreview, stopPreview, currentPreview, UPLOAD_PREFIX } from '../restore.js';
import { langOverride, ghOwnerEnv, ghRepoEnv, launchDryRun, PORT } from '../config.js';
import { claudeWord, launchOptions, launchProblem, launchSpec, runLaunch } from '../launch.js';
import { TMUX_COMMAND_MAX, boardProblem, folderTrusted, phantomAvailable, phantomPane, phantomSpec, phantomStop, runPhantom, taskTerminal, tmuxBin, tmuxCommandBytes } from '../phantom.js';
import { freshTerminalSessions, isBoardSession, markBoardSession, markResumed, prepHolder, tieLaunched } from '../claude-sessions.js';
import { CHECK_LABEL, OPEN_CHECK, doneRules, isCheck, leadCheck } from '../review-check.js';
import { liveTick, readRegistry } from '../claude-live.js';
import { freeFolderFor, resolveProject } from './projects.js';
import { moveLaunched, resolveTask, snapshot, TASK_SELECT } from './tasks.js';
import { isManual } from '../task-shape.js';
import { packagedSkillNames, packagedSkillState, refreshPackagedSkill } from '../skills.js';
import { isGuest } from '../share.js';

export const ONBOARDING_VERSION = 5;

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
  if (!packaged) {
    return { how: 'git', cmd: 'git', args: ['pull', '--ff-only'], then: { cmd: 'npm', args: ['install', '--no-fund', '--no-audit'] } };
  }
  const args = ['install', '-g', `${name}@latest`];
  const prefix = globalPrefixOf(root, name);
  if (prefix) args.push('--prefix', prefix);
  return { how: 'npm', cmd: 'npm', args };
}

export async function runUpdate(plan, exec) {
  const first = await exec(plan.cmd, plan.args);
  if (first.err || !plan.then) return { ...first, step: plan };
  const second = await exec(plan.then.cmd, plan.then.args);
  return { err: second.err, text: `${first.text}\n${second.text}`.trim(), step: second.err ? plan.then : plan };
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

export const skillStates = () => Object.fromEntries(packagedSkillNames().map((name) => [name, packagedSkillState(name)]));
export function bringSkills(before) {
  const out = { refreshed: [], kept: [], failed: [] };
  for (const [name, was] of Object.entries(before || {})) {
    if (was === 'differs') { out.kept.push(name); continue; }
    if (was !== 'same') continue;
    try {
      const r = refreshPackagedSkill(name);
      if (r.error) out.failed.push(name);
      else if (r.written.length) out.refreshed.push(name);
    } catch (e) {
      out.failed.push(name);
      logError('server', 'update', `the skill ${name} did not come along with the update: ${e.message}`);
    }
  }
  return out;
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

export async function gitFreshness(local, remote, git) {
  if (remote === local) return { update_available: false, ahead: false };
  const contained = await git(['merge-base', '--is-ancestor', remote, local]) !== null;
  return { update_available: !contained, ahead: contained };
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

const FRONT_FILE = /\.(js|html|css)$/;
export function frontVersion(publicDir) {
  let newest = 0;
  for (const dir of [publicDir, join(publicDir, 'js')]) {
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!FRONT_FILE.test(f)) continue;
      try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch {  }
    }
  }
  return newest;
}

const UPLOAD = Symbol('kb.upload');

function uploadParser(req, payload, done) {
  const limit = uploadLimit();
  const file = join(tmpdir(), `${UPLOAD_PREFIX}${process.pid}-${Date.now()}.db`);
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
  out.on('close', () => {
    if (failed) return;
    req[UPLOAD] = { file, size };
    done(null);
  });
  payload.pipe(out);
}

export default async function systemRoutes(app) {
  app.get('/api/labels', () => ({
    palette: Object.fromEntries(Object.entries(LABELS).map(([name, hex]) => [name, `#${hex}`])),
    selectable: Object.keys(LABELS).filter((name) => !MANAGED_LABELS.has(name) && name !== CHECK_LABEL),
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
  const clientErrSeen = new Map();
  const CLIENT_ERR_EVERY = 10000;
  const CLIENT_ERR_MAX = 500; // = the cut of logError (db.js) and of the page's report (core.js)
  const ownCopy = (str) => Buffer.from(str, 'utf8').toString('utf8');
  app.delete('/api/errors', () => { clearErrors(); clientErrSeen.clear(); return { ok: true }; });
  app.post('/api/errors', (req, reply) => {
    // carried up to ~1 MB of each — 199 such messages held 200 MB until the 201st different one came. Both are cut where
    // logError cuts what it writes (and where the page cuts what it sends) — and copied: a slice of a long string in V8
    // keeps the whole string alive.
    const message = ownCopy(String(req.body?.message ?? '').trim().slice(0, CLIENT_ERR_MAX));
    const scope = req.body?.scope == null ? req.body?.scope : ownCopy(String(req.body.scope).slice(0, 200));
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const now = Date.now();
    if (now - (clientErrSeen.get(message) || 0) < CLIENT_ERR_EVERY) return { ok: true, skipped: true };
    clientErrSeen.set(message, now);
    if (clientErrSeen.size > 200) {
      for (const [k, at] of clientErrSeen) if (now - at > CLIENT_ERR_EVERY) clientErrSeen.delete(k);
    }
    logError('client', scope, message, req.body?.detail);
    return { ok: true };
  });

  const uiVersion = () => frontVersion(join(ROOT_DIR, 'public'));
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
      // the file they replace goes among THIS board's backups, not into the data folder of their own process
      data_dir: DATA_DIR,
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
  const oneFlight = (run) => {
    let flight = null;
    return () => {
      if (!flight) flight = run().finally(() => { flight = null; });
      return flight;
    };
  };
  const checkUpdate = oneFlight(async () => {
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
        if (remote) data = { ...await gitFreshness(local, remote, git), local: local.slice(0, 7), remote: remote.slice(0, 7), branch, tag, dev: null };
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
  app.get('/api/update-check', async (req) => {
    const forced = Boolean(req.query?.refresh) && Date.now() - lastForced >= FORCE_EVERY;
    if (forced) lastForced = Date.now();
    if (!forced && updCache.data && Date.now() - updCache.at < updCache.ttl) return updCache.data;
    return checkUpdate();
  });

  const NEWS_OK_MS = 3600000;
  const NEWS_FAIL_MS = 60000;
  let newsCache = { at: 0, ttl: 0, data: null };
  let newsForced = 0;
  const ownNews = () => {
    const version = selfPkg()?.version || null;
    let text = null;
    try { text = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8'); } catch {  }
    return { version, notes: (text && version) ? changelogSection(text, version) : null, source: 'changelog', url: null };
  };
  const fetchNews = oneFlight(async () => {
    const repo = repoSlug(selfPkg()?.repository);
    const rel = repo ? await ghApi(`repos/${repo}/releases/latest`) : null;
    const tag = String(rel?.tag_name || '').replace(/^v/, '');
    const body = String(rel?.body || '').trim();
    const got = Boolean(tag && body);
    const data = got
      ? { version: tag, notes: body, source: 'github', url: rel.html_url || null }
      : ownNews();
    newsCache = { at: Date.now(), ttl: got ? NEWS_OK_MS : NEWS_FAIL_MS, data };
    return data;
  });
  app.get('/api/whats-new', async (req) => {
    if (!req.query?.remote) return ownNews();
    const forced = Boolean(req.query?.refresh) && Date.now() - newsForced >= FORCE_EVERY;
    if (forced) newsForced = Date.now();
    if (!forced && newsCache.data && Date.now() - newsCache.at < newsCache.ttl) return newsCache.data;
    return fetchNews();
  });

  let updateRunning = null;
  app.post('/api/update', async (req, reply) => {
    if (process.env.KB_PREVIEW_TTL_MS) return reply.code(403).send({ error: 'this is a check board opened from a backup — it does not update the code' });
    if (updateRunning) return reply.code(409).send({ error: 'an update is already running' });
    const pkg = selfPkg();
    const plan = updatePlan({ packaged: PACKAGED, name: pkg?.name, root: ROOT_DIR });
    if (plan.how === 'npm' && !pkg?.name) return reply.code(500).send({ error: 'cannot tell which package to update' });

    const exec = (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { cwd: ROOT_DIR, timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
        (err, out, errOut) => resolve({ err, text: `${out || ''}${errOut || ''}`.trim() }));
    });
    let skillsBefore = {};
    try { skillsBefore = skillStates(); } catch (e) { logError('server', 'update', `the skills could not be looked at before the update: ${e.message}`); }
    const run = runUpdate(plan, exec);
    updateRunning = run;
    let res;
    try { res = await run; } finally { if (updateRunning === run) updateRunning = null; }

    const output = res.text.slice(-2000);
    if (res.err) {
      logError('server', 'update', `update via ${plan.how} failed: ${res.err.message}`, output);

      const { step } = res;
      return reply.code(500).send({
        ok: false, how: plan.how, output, cmd: [step.cmd, ...step.args].join(' '),
        error: failureReason(output, res.err.message),
      });
    }
    const skills = bringSkills(skillsBefore);
    const restart = restartMode();
    if (restart === 'pm2') setTimeout(() => process.exit(0), 400).unref();
    updCache = { at: 0, ttl: 0, data: null };
    return { ok: true, how: plan.how, restart, output, skills };
  });

  const noFolder = (p, error) => ({
    error, fallback: true, reason: 'no-folder', project: p.slug, name: p.name, missing: p.path || null, suggest: freeFolderFor(p.slug),
  });
  // (KB_ALLOWED_HOSTS) that is the proxy's port, or none at all on https: a Claude it named the board to went elsewhere
  app.get('/api/launch', () => ({ ...launchOptions(), board: phantomAvailable(), port: PORT }));
  const launching = new Set();
  async function tieUnheld(tasks, sid, moved) {
    const fresh = freshTerminalSessions();
    const registry = await readRegistry();
    const alive = async (holder) => {
      if (isBoardSession(holder)) { const st = await phantomPane(holder); return Boolean(st && !st.dead); }
      return fresh.has(holder) || Boolean(registry.get(holder)?.alive);
    };
    for (const t of tasks) {
      if (moved.includes(t.key)) continue; // its move into prep is the session's own already
      const holder = prepHolder(t.id);
      if (holder && holder !== sid && await alive(holder)) continue;
      tieLaunched(t.id, sid);
    }
  }
  const manualRefusal = (tasks) => {
    const manual = tasks.filter((t) => isManual(t.labels)).map((t) => t.key);
    return manual.length ? { code: 409, error: `done by hand (noclaude), so Claude is not started on it: ${manual.join(', ')}`, reason: 'manual', manual } : null;
  };
  const checkRefusal = (tasks) => {
    for (const t of tasks) {
      const lead = isCheck(t) ? leadCheck(t.project_id) : null;
      const open = lead && lead.id !== t.id ? lead : null;
      if (open) return { code: 409, error: `${open.key} is already checking this project`, reason: 'check-open', key: open.key };
    }
    return null;
  };
  const launchTasks = (keys, p) => {
    const tasks = (keys || []).map((k) => resolveTask(k));
    if (tasks.some((t) => !t)) return { code: 404, error: 'task not found' };
    if (p && tasks.some((t) => t.project_id !== p.id)) return { code: 400, error: 'keys: tasks of this project only' };
    return manualRefusal(tasks) || checkRefusal(tasks) || { tasks };
  };
  app.post('/api/launch', async (req, reply) => {
    const b = req.body || {};
    if (b.mode === 'board') return launchBoard(b, reply);
    if (isGuest(req)) return reply.code(403).send({ error: 'a guest starts Claude inside the board only', reason: 'guest' });
    const problem = launchProblem(b);
    if (problem) return reply.code(400).send({ error: problem });
    let folder = null;
    let p = null;
    if (b.project !== undefined && b.project !== null) {
      if (typeof b.project !== 'string') return reply.code(400).send({ error: 'project: a project key' });
      p = resolveProject(b.project);
      if (!p) return reply.code(404).send({ error: 'project not found' });
      if (!p.path || !existsSync(p.path)) {
        return reply.code(409).send(noFolder(p, 'the project has no folder on this computer — set it in the project: without it Claude would start in the home folder'));
      }
      folder = p.path;
    }
    const picked = launchTasks(b.keys, p);
    if (picked.error) { const { code, ...body } = picked; return reply.code(code).send(body); }
    if (b.mode === 'desktop' && !launchDryRun() && !launchOptions().desktop) {
      return reply.code(409).send({ error: 'the Claude app is not installed here — pick Terminal or Copy in Settings' });
    }
    // new work in a terminal goes under a session id the board picks, as inside the board; the app names its own
    const session = b.mode === 'terminal' && b.text !== undefined ? randomUUID() : null;
    let spec;
    try { spec = launchSpec({ mode: b.mode, text: b.text, folder, resume: b.resume, host: b.host, session, url: `http://127.0.0.1:${PORT}`, effort: b.effort, bin: claudeWord() }); } catch (e) {
      return reply.code(e.statusCode || 500).send({ error: e.message });
    }
    const named = session ? { session } : {};
    if (launchDryRun()) return { ok: true, dry: true, folder, ...named, ...spec };
    const keys = picked.tasks.map((t) => t.key);
    const busy = keys.filter((k) => launching.has(k));
    if (busy.length) return reply.code(409).send({ error: `Claude is being started on ${busy.join(', ')}`, reason: 'starting' });
    keys.forEach((k) => launching.add(k));
    try {
      const res = await runLaunch(spec);
      if (res.err) {
        logError('server', 'launch', `launch via ${b.mode} failed: ${res.err.message}`, res.text);
        return reply.code(500).send({ error: failureReason(res.text, res.err.message) });
      }
      // the tasks it moves become the started Claude's (commitPatch ties its session to them); of the rest, only the
      // ones no live Claude holds (tieUnheld) — the second Claude is told the others are taken
      const prep = b.mode === 'desktop' ? [] : moveLaunched(picked.tasks, session, b.mode);
      if (session) await tieUnheld(picked.tasks, session, prep);
      if (prep.length) liveTick(); // their cards say "starting" now, not at the next look in up to 3 s
      return { ok: true, folder, ...named, prep };
    } finally {
      keys.forEach((k) => launching.delete(k));
    }
  });

  async function launchBoard(b, reply) {
    const problem = boardProblem(b) || (b.resume === undefined ? launchProblem({ mode: 'terminal', text: b.text }) : null);
    if (problem) return reply.code(400).send({ error: problem });
    if (typeof b.project !== 'string') return reply.code(400).send({ error: 'project: inside the board Claude starts only in a project folder', fallback: true, reason: 'no-project' });
    const p = resolveProject(b.project);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    if (!p.path || !existsSync(p.path)) {
      return reply.code(409).send(noFolder(p, 'the project has no folder on this computer — set it in the project, or pick another way to start Claude in Settings'));
    }
    const tasks = (b.keys || []).map((k) => resolveTask(k));
    if (tasks.some((t) => !t)) return reply.code(404).send({ error: 'task not found' });
    if (tasks.some((t) => t.project_id !== p.id)) return reply.code(400).send({ error: 'keys: tasks of this project only' });
    const manual = manualRefusal(tasks) || checkRefusal(tasks);
    if (manual) { const { code, ...body } = manual; return reply.code(code).send(body); }
    if (!launchDryRun() && !phantomAvailable()) {
      return reply.code(409).send({ error: 'tmux or claude is not installed here — pick another way to start Claude in Settings', fallback: true, reason: tmuxBin() ? 'no-claude' : 'no-tmux' });
    }
    const keys = tasks.map((t) => t.key);
    const busy = keys.filter((k) => launching.has(k));
    if (busy.length) return reply.code(409).send({ error: `Claude of the board is starting on ${busy.join(', ')}`, running: busy });
    keys.forEach((k) => launching.add(k));
    try {
      const running = [];
      const unsure = [];
      for (const t of tasks) {
        const term = await taskTerminal(t.id, { strict: true });
        if (term?.unknown) unsure.push(t.key); else if (term && !term.dead) running.push(t.key);
      }
      if (running.length) return reply.code(409).send({ error: `Claude of the board already works on ${running.join(', ')}`, running });
      if (unsure.length) {
        return reply.code(409).send({ error: `tmux did not answer in time: whether a Claude of the board works on ${unsure.join(', ')} is not known — try again`, reason: 'tmux-slow', keys: unsure });
      }
      if (b.resume !== undefined) return await resumeBoard(b, p, tasks, reply);
      const sid = randomUUID();
      const name = keys.length > 1 ? `${keys[0]} +${keys.length - 1}` : (keys[0] || p.slug);
      // was the person's word for exactly those
      const spec = phantomSpec({ sid, name, text: b.text, folder: p.path, permission: b.permission, port: PORT, allow: doneRules(tasks), effort: b.effort });
      const bytes = tmuxCommandBytes(spec.args);
      if (bytes > TMUX_COMMAND_MAX) {
        return reply.code(400).send({
          error: `text: too long for the board's terminal — the start takes ${bytes} bytes, tmux takes at most ${TMUX_COMMAND_MAX} (a Cyrillic letter is two)`,
          fallback: true, reason: 'too-long',
        });
      }
      const trusted = folderTrusted(p.path);
      if (launchDryRun()) return { ok: true, dry: true, session: sid, folder: p.path, trusted, keys, ...spec };
      const res = await runPhantom(spec);
      if (res.err) {
        logError('server', 'launch', `launch inside the board failed: ${res.err.message}`, res.text);
        return reply.code(500).send({ error: failureReason(res.text, res.err.message) });
      }
      markBoardSession(sid);
      const prep = moveLaunched(tasks, sid, 'board');
      await tieUnheld(tasks, sid, prep); // and the card of each task finds the terminal at once
      if (prep.length) liveTick();
      return { ok: true, session: sid, folder: p.path, trusted, keys, prep };
    } finally {
      keys.forEach((k) => launching.delete(k));
    }
  }

  async function resumeBoard(b, p, tasks, reply) {
    const sid = b.resume;
    const keys = tasks.map((t) => t.key);
    // every task of the request is the session's own (acceptance): a key it never held would get its name and the rules
    // of a check (`kb done`) on a Claude that never worked on it
    const tied = tasks.length > 0 && db.prepare('SELECT COUNT(DISTINCT task_id) AS n FROM task_sessions WHERE session_id = ? AND task_id IN (SELECT value FROM json_each(?))')
      .get(sid, JSON.stringify(tasks.map((t) => t.id))).n === new Set(tasks.map((t) => t.id)).size;
    if (!tied || !isBoardSession(sid)) return reply.code(404).send({ error: 'resume: no session of the board for these tasks', reason: 'no-session' });
    // one session, one start (acceptance): its two tasks show «Continue» each, the lock of the keys lets both presses
    // through, both see the terminal dead — and the second failed on tmux's «duplicate session» or stopped the fresh Claude
    if (launching.has(sid)) return reply.code(409).send({ error: `Claude of the board is starting on ${keys.join(', ')}`, running: keys });
    launching.add(sid);
    try {
      return await resumeSession(b, p, tasks, reply, sid, keys);
    } finally {
      launching.delete(sid);
    }
  }
  async function resumeSession(b, p, tasks, reply, sid, keys) {
    const pane = await phantomPane(sid);
    if (pane?.unknown) return reply.code(409).send({ error: 'tmux did not answer in time — try again', reason: 'tmux-slow', keys });
    if (pane && !pane.dead) return reply.code(409).send({ error: `Claude of the board already works on ${keys.join(', ')}`, running: keys });
    const name = keys.length > 1 ? `${keys[0]} +${keys.length - 1}` : keys[0];
    const spec = phantomSpec({ sid, name, folder: p.path, permission: b.permission, port: PORT, allow: doneRules(tasks), effort: b.effort, resume: true });
    const trusted = folderTrusted(p.path);
    if (launchDryRun()) return { ok: true, dry: true, session: sid, folder: p.path, trusted, keys, resumed: true, ...spec };
    if (pane) await phantomStop(sid); // a session left behind fails the start below with its own words
    const res = await runPhantom(spec);
    if (res.err) {
      logError('server', 'launch', `resume inside the board failed: ${res.err.message}`, res.text);
      return reply.code(500).send({ error: failureReason(res.text, res.err.message) });
    }
    markBoardSession(sid);
    markResumed(sid); // «starting» on its cards until Claude Code puts it into its registry
    liveTick();
    emit('session.chat', { session: sid });
    return { ok: true, session: sid, folder: p.path, trusted, keys, prep: [], resumed: true };
  }

  app.get('/api/lang', () => ({ lang: uiLang(), source: langOverride() ? 'env' : 'kv' }));
  app.post('/api/lang', (req) => {
    // (what the server writes: answers to Claude's questions in comments, GitHub columns of new projects). A guest's
    // language stays in the guest's browser; the answer is the board's, and no refusal — the page sends it on every start.
    if (isGuest(req)) return { lang: uiLang(), guest: true };
    if (!langOverride()) kvSet('ui.lang', req.body?.lang === 'en' ? 'en' : 'ru');
    return { lang: uiLang() };
  });

  const onboardingSeen = () => Number(kvGet('onboarding.version')) || (kvGet('onboarding.done') === '1' ? 1 : 0);
  const onboardingState = () => ({ done: onboardingSeen() >= ONBOARDING_VERSION, seen: onboardingSeen(), version: ONBOARDING_VERSION });
  app.get('/api/onboarding', onboardingState);
  app.post('/api/onboarding', (req) => {
    const done = Boolean(req.body?.done);
    kvSet('onboarding.done', done ? '1' : '0');
    kvSet('onboarding.version', done ? String(ONBOARDING_VERSION) : '0');
    return onboardingState();
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
  app.register(async function backupUpload(scope) {
    scope.addContentTypeParser('application/octet-stream', uploadParser);
    scope.post('/api/backups/restore', async (req, reply) => {
      const up = req[UPLOAD];
      if (!up) return reply.code(415).send({ error: 'send the backup file itself, as application/octet-stream' });
      const drop = () => { try { rmSync(up.file, { force: true }); } catch {  } };
      if (!up.size) { drop(); return reply.code(400).send({ error: 'empty file' }); }
      if (uploading) { drop(); return reply.code(409).send({ error: 'another backup is already being opened' }); }
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
        uploading = false;
        drop();
      }
    });
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
