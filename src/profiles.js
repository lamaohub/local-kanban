import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA_DIR } from './db.js';
import { EFFORT_LEVELS, EFFORT_VAR } from './launch.js';

export const PROFILES_MAX = 30;
export const ENV_MAX = 30;
const NAME_RE = /^[^\p{Cc}\u2028\u2029]{1,40}$/u;
const MODEL_RE = /^[A-Za-z0-9._:/[\]][A-Za-z0-9._:/[\]-]{0,99}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_REFUSED = /^(KB_\w*|PATH|HOME|SHELL|USER|LANG|LC_\w+|TERM|TMUX\w*|CLAUDE_CODE_SESSION_ID|CLAUDECODE|CLAUDE_CODE_SIMPLE|CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN|CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)$/;
const ENV_LOADER = /^(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|NODE_OPTIONS|BASH_ENV|ENV)$/;
export const KEEP = '***'; // a value the page sends back unchanged: keep the one stored

const parse = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/** A profile as a page sees it: its env with the names only. */
export const shown = (p) => p && ({ id: p.id, name: p.name, model: p.model || '', effort: p.effort || '', env: Object.keys(parse(p.env)), third_party: thirdParty(p) });
export const thirdParty = (p) => Boolean(p && Object.hasOwn(parse(p.env), 'ANTHROPIC_BASE_URL'));
export const profileById = (id) => (Number.isInteger(id) ? db.prepare('SELECT * FROM launch_profiles WHERE id = ?').get(id) : null) || null;
export const listProfiles = () => db.prepare('SELECT * FROM launch_profiles ORDER BY name COLLATE NOCASE, id').all().map(shown);

/** The profile of the request {name, model, effort, env} checked against `was` (a profile kept; null for a new one):
    {row} to write — or {error, field}. `env` is {NAME: value}: `KEEP` keeps the stored value, a name left out is dropped. */
export function profileInput(body, was = null) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : was?.name;
  if (!name || !NAME_RE.test(name)) return { error: 'name: 1–40 characters on one line', field: 'name' };
  // the type first: String() of an object with a toString that is no function throws — a 500 instead of a 400
  if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') return { error: 'model: a model id', field: 'model' };
  if (b.effort !== undefined && b.effort !== null && typeof b.effort !== 'string') return { error: `effort: one of ${EFFORT_LEVELS.join(', ')}`, field: 'effort' };
  const model = b.model === undefined ? (was?.model || '') : String(b.model ?? '').trim();
  if (model && !MODEL_RE.test(model)) return { error: 'model: a model id (letters, digits, . _ : / - [ ], not starting with -)', field: 'model' };
  const effort = b.effort === undefined ? (was?.effort || '') : String(b.effort ?? '');
  if (effort && !EFFORT_LEVELS.includes(effort)) return { error: `effort: one of ${EFFORT_LEVELS.join(', ')}`, field: 'effort' };
  let env = parse(was?.env);
  if (b.env !== undefined) {
    if (!b.env || typeof b.env !== 'object' || Array.isArray(b.env)) return { error: 'env: {NAME: value}', field: 'env' };
    const old = env;
    env = {};
    for (const [k, v] of Object.entries(b.env)) {
      if (!ENV_KEY_RE.test(k)) return { error: `env: ${k.slice(0, 40)} is not a variable name (A-Z, 0-9, _)`, field: 'env' };
      if (ENV_REFUSED.test(k)) return { error: `env: ${k} is the board's own — a profile does not set it`, field: 'env' };
      if (k === EFFORT_VAR) return { error: `env: ${k} is the effort of the profile — pick it there`, field: 'env' };
      if (ENV_LOADER.test(k)) return { error: `env: ${k} loads code into every program Claude starts — a profile does not set it`, field: 'env' };
      if (v === KEEP) { if (Object.hasOwn(old, k)) env[k] = old[k]; continue; }
      if (typeof v !== 'string' || v.length > 4000 || v.includes('\0')) return { error: `env: the value of ${k} — text up to 4000 characters`, field: 'env' };
      env[k] = v;
    }
    if (Object.keys(env).length > ENV_MAX) return { error: `env: at most ${ENV_MAX} variables`, field: 'env' };
  }
  return { row: { name, model, effort, env: JSON.stringify(env) } };
}

/** The profile a start of these tasks of `project` gets: the first task's own, else the project's, else none. */
export function profileFor(tasks, project) {
  for (const t of tasks) {
    const own = db.prepare('SELECT profile_id FROM task_profiles WHERE task_id = ?').get(t.id)?.profile_id;
    if (own) return profileById(own);
  }
  return project?.profile_id ? profileById(project.profile_id) : null;
}

let writes = 0;
/** `text` as the file `path`, whole: a temporary file of 0600 and one rename — a Claude starting meanwhile never reads half. */
function writeWhole(path, text) {
  const part = `${path}.${process.pid}.${++writes}.part`;
  try {
    writeFileSync(part, text, { mode: 0o600 });
    renameSync(part, path);
  } catch (e) { rmSync(part, { force: true }); throw e; }
}
const settingsText = (base, env) => `${JSON.stringify({ ...base, ...(Object.keys(env).length ? { env } : {}) })}\n`;
export function settingsFile(profile, port, base = {}, kind = '') {
  const path = join(DATA_DIR, `launch-${port}-p${profile.id}${kind ? `-${kind}` : ''}.json`);
  writeWhole(path, settingsText(base, parse(profile.env)));
  return path;
}
/** The settings files of profile `id` in the board's data — of every port and way of starting (temporary ones too). */
export function profileFiles(id) {
  const re = new RegExp(`^launch-\\d+-p${Number(id)}(-[a-z]+)?\\.json($|\\.)`);
  try { return readdirSync(DATA_DIR).filter((f) => re.test(f)).map((f) => join(DATA_DIR, f)); } catch { return []; }
}
export function dropProfileFiles(id) {
  for (const f of profileFiles(id)) rmSync(f, { force: true });
}
export function refreshProfileFiles(profile) {
  const env = parse(profile.env);
  for (const f of profileFiles(profile.id)) {
    if (f.endsWith('.part')) continue;
    let base;
    try { base = JSON.parse(readFileSync(f, 'utf8')); } catch { base = null; }
    if (!base || typeof base !== 'object' || Array.isArray(base)) { rmSync(f, { force: true }); continue; }
    delete base.env;
    try { writeWhole(f, settingsText(base, env)); } catch { rmSync(f, { force: true }); } // never the old keys left behind
  }
}

/** The session was started on this profile: kept for the usage (another provider — no prices of Anthropic). */
export function markSessionProfile(sid, profile) {
  if (!sid || !profile) return;
  db.prepare(`INSERT INTO session_profiles (session_id, profile_id, third_party) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET profile_id = excluded.profile_id, third_party = excluded.third_party`).run(sid, profile.id, thirdParty(profile) ? 1 : 0);
}
export const thirdPartySession = (sid) => Boolean(db.prepare('SELECT third_party FROM session_profiles WHERE session_id = ?').get(sid)?.third_party);
