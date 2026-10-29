
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeBin, claudeDir, claudeDirFrom, missingClaudeDir, missingClaudeDirError, PORT } from './config.js';
import { desktopApp, findClaude, launchOptions, onPath } from './launch.js';
import { cleanEnv, NOT_FOR_BOARD, tmuxBin } from './phantom.js';
import { readRegistry } from './claude-live.js';
import { readLimits } from './claude-limits.js';
import { BOARD_SKILL, packagedSkillState } from './skills.js';
import { otherBoard, planInstall, planUninstall } from './claude-hooks.js';
import { boardKb, fingerprint, readSettings, writeProblem, writeSettings } from './claude-settings.js';

// the board's own address, as kb in settings.json is to reach it (written only when it is not the default one)
const boardUrl = () => `http://127.0.0.1:${PORT}`;
const WRITES = new Set(['add', 'chain', 'update', 'restore', 'remove']);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const runnable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const folders = (p) => { try { return readdirSync(p).filter((f) => isDir(join(p, f))).length; } catch { return 0; } };
const missingKbDir = missingClaudeDir;
export const LIMITS_FRESH_MS = 5 * 3600 * 1000;

/** settings.json as the page needs it: where it is, whether it can be read and written, what connecting and taking
    off would change (`install`, `uninstall` — the changes of planInstall / planUninstall), the state of each entry
    (`status_line`, `hook` — the action connecting would take: `already` means connected as it is now), the
    fingerprint the page sends back with its consent (`seen`) and the address of another board the entries speak to
    (`other_board`, null when they speak to this one or there are none). */
export function settingsState() {
  const read = readSettings();
  const out = { path: read.path, exists: read.existed, error: read.error || null };
  if (read.error) return out;
  const install = planInstall(read.settings, boardKb(boardUrl())).changes;
  const why = missingKbDir() ? 'no-folder' : writeProblem(read);
  return {
    ...out,
    writable: !why,
    why,
    seen: fingerprint(read),
    status_line: install.find((c) => c.part === 'statusLine')?.action ?? null,
    hook: install.find((c) => c.part === 'PermissionRequest')?.action ?? null,
    install,
    uninstall: planUninstall(read.settings).changes,
    other_board: otherBoard(read.settings, PORT),
  };
}

export function statusLineLink() {
  const s = settingsState();
  if (s.error) return null;
  const odd = (s.install || []).some((c) => c.part === 'statusLine' && c.action === 'skip' && c.ours);
  if (s.status_line === 'already' || odd) return 'connected';
  if (s.status_line === 'skip') return 'manual';
  return s.status_line === 'update' && s.other_board ? 'other' : 'off';
}

const KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export function envState(env = process.env, settings = readSettings().settings) {
  const passed = cleanEnv(env);
  const key = (v) => typeof v === 'string' && v.trim() !== '';
  // a switch: 0, false, no, off — and empty — are off, as for Claude Code's other on/off variables
  const on = (v) => (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') && !/^\s*(0|false|no|off)?\s*$/i.test(String(v));
  const own = settings && typeof settings.env === 'object' && settings.env ? settings.env : {};
  return {
    // what cleanEnv would have passed on, had the board not taken it off: nothing of the person's from a Claude session
    taken_off: env.CLAUDECODE ? [] : NOT_FOR_BOARD.filter((k) => on(env[k])),
    keys: KEY_NAMES.filter((k) => key(passed[k])),
    settings: [...NOT_FOR_BOARD.filter((k) => on(own[k])), ...KEY_NAMES.filter((k) => key(own[k]))],
  };
}

export function fullDiskAccess(file = join(homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')) {
  if (process.platform !== 'darwin') return null;
  try { closeSync(openSync(file, 'r')); return true; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES' ? false : null; }
}

/** Everything at once. `probe` stands in for what cannot be moved by the environment in a test: the platform, the
    programs found in fixed places (tmux, the app) and the registry of live sessions. */
export async function claudeSetup(probe = {}) {
  const p = {
    platform: process.platform,
    claude: () => findClaude(),
    tmux: () => tmuxBin(),
    app: () => desktopApp(),
    terminal: () => launchOptions().terminal,
    registry: () => readRegistry(),
    fda: () => fullDiskAccess(),
    pm2: undefined,
    ...probe,
  };
  const dir = claudeDir();
  const skillDir = join(dir, 'skills', BOARD_SKILL);
  let symlink = false;
  try { symlink = lstatSync(skillDir).isSymbolicLink(); } catch { /* no skill */ }
  const sessionsDir = join(dir, 'sessions');
  const live = isDir(sessionsDir) ? [...(await p.registry()).values()] : [];
  const transcripts = join(dir, 'projects');
  const hit = p.claude();
  const found = typeof hit === 'string' ? { path: hit, from: 'PATH' } : hit;
  const claude = found && runnable(found.path) ? found.path : null; // KB_CLAUDE_BIN is taken as written, even when nothing is there
  // claude is on PATH, where the board would find it without the variable), not "how to install Claude Code"
  const bin = claudeBin();
  const at = readLimits()?.at ?? null;
  return {
    platform: p.platform,
    claude: !claude && bin ? { path: null, from: 'KB_CLAUDE_BIN', set: bin, on_path: onPath('claude') }
      : { path: claude, from: claude ? found.from : 'PATH' },
    tmux: { path: p.tmux() || null },
    app: { path: p.platform === 'darwin' ? (p.app() || null) : null, supported: p.platform === 'darwin' },
    terminal: { ok: Boolean(p.terminal()), how: p.platform === 'darwin' ? 'Terminal' : 'x-terminal-emulator' },
    folder: { path: dir, from: claudeDirFrom(), exists: isDir(dir) },
    // from an older version used to show as fine, since only the file being there was looked at
    skill: { path: join(skillDir, 'SKILL.md'), exists: existsSync(join(skillDir, 'SKILL.md')), symlink, state: packagedSkillState(BOARD_SKILL) },
    registry: { path: sessionsDir, exists: isDir(sessionsDir), sessions_n: live.length, live_n: live.filter((e) => e.alive).length },
    transcripts: { path: transcripts, exists: isDir(transcripts), projects_n: folders(transcripts) },
    limits: { at, fresh: Boolean(at) && Date.now() - Date.parse(at) < LIMITS_FRESH_MS },
    settings: settingsState(),
    env: envState(),
    // `pm2`: macOS asks in the name of the responsible process — node under pm2 (launchd starts it), else the app the
    // board was started from (Terminal, iTerm…); the open of TCC.db is judged the same way, so `full_disk` holds either way
    macos: p.platform === 'darwin' && p.tmux() ? { node: process.execPath, full_disk: p.fda(), pm2: Boolean(p.pm2 ?? process.env.pm_id !== undefined) } : null,
  };
}

const READ_ERRORS = {
  'not-json': 'is not valid JSON — fix it first; nothing was written',
  'not-object': 'does not hold a JSON object — nothing was written',
  unreadable: 'cannot be read — nothing was written',
};

/** Connect (`install`) or take off (`uninstall`) as the person agreed on the page: `seen` is the fingerprint of the
    file the change was shown for, and a file that is no longer that one is not written — the page shows the change
    again. Returns {ok, written, changes, path, target, kept} or {status, error, reason}. */
export function changeHooks(action, seen) {
  if (missingKbDir()) return { status: 409, error: missingClaudeDirError(), reason: 'no-folder' };
  const read = readSettings();
  if (read.error) return { status: 409, error: `${read.path} ${READ_ERRORS[read.error]}`, reason: read.error };
  if (fingerprint(read) !== seen) return { status: 409, error: 'settings.json changed since the page read it — nothing was written; look at the change again', reason: 'changed' };
  const { settings: next, changes } = action === 'install' ? planInstall(read.settings, boardKb(boardUrl())) : planUninstall(read.settings);
  if (!changes.some((c) => WRITES.has(c.action))) return { ok: true, written: false, changes, path: read.path };
  const w = writeSettings(read, next);
  if (w.error === 'changed') return { status: 409, error: 'settings.json changed since the page read it — nothing was written; look at the change again', reason: 'changed' };
  if (w.error === 'read-only') return { status: 409, error: `${w.target} is not writable — nothing was written`, reason: 'read-only' };
  if (w.error === 'folder') return { status: 409, error: `the folder of ${w.target} is not writable — nothing was written`, reason: 'folder' };
  if (w.error === 'no-copy') return { status: 500, error: `could not keep a copy of ${read.path} among the board's snapshots (${w.message}) — nothing was written`, reason: 'no-copy' };
  if (w.error) return { status: 500, error: `could not write ${w.target || read.path} (${w.message}) — nothing was written`, reason: 'write' };
  return { ok: true, written: true, changes, path: read.path, target: w.target, kept: w.kept };
}
