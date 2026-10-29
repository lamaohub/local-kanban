
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { HOST_SESSION_RE, SESSION_ID_RE } from './claude-sessions.js';
import { claudeBin } from './config.js';

/** What the Claude app takes in `?q=` (WA in its URL handler); longer text is refused, not cut. */
export const PROMPT_MAX = 14336;

export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
}

const runnable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

const INSTALL_PLACES = (home) => [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const versionKey = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
const newer = (a, b) => { const x = versionKey(a); const y = versionKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
/** The copy of Claude Code the Claude app keeps for itself (macOS), newest version first; null when there is none. */
export function appClaude(home = homedir(), platform = process.platform) {
  if (platform !== 'darwin') return null;
  const root = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  for (const version of list(root).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => newer(b, a))) {
    for (const build of list(join(root, version))) {
      const p = join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (runnable(p)) return p;
    }
  }
  return null;
}
/** Claude Code on this machine: {path, from} — `from` is KB_CLAUDE_BIN (taken as written, even when nothing is
    there: the variable is the person's word), PATH, `place` (a place an installer puts it) or `app` (the copy of the
    Claude app); null when there is none. */
export function findClaude(env = process.env) {
  const bin = claudeBin();
  if (bin) return { path: bin, from: 'KB_CLAUDE_BIN' };
  const onp = onPath('claude', env);
  if (onp) return { path: onp, from: 'PATH' };
  const home = homedir();
  const place = INSTALL_PLACES(home).find(runnable);
  if (place) return { path: place, from: 'place' };
  const app = appClaude(home);
  return app ? { path: app, from: 'app' } : null;
}
export function claudeRunnable() {
  const found = findClaude();
  return Boolean(found && (found.from !== 'KB_CLAUDE_BIN' || runnable(found.path)));
}
/** The program the board starts as Claude, or null. */
export const claudeCli = () => findClaude()?.path || null;
/** How a terminal window names Claude: `claude` when it is on the PATH (the window's shell has the person's own),
    else the full path the board found — a terminal would not find it by name either. */
export function claudeWord() {
  const found = findClaude();
  return found && found.from !== 'PATH' && found.from !== 'KB_CLAUDE_BIN' ? shellQuote(found.path) : 'claude';
}

/** The Claude desktop app, if it is installed where macOS keeps apps. */
export function desktopApp() {
  if (process.platform !== 'darwin') return null;
  return ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')].find((p) => existsSync(p)) || null;
}

/** Which ways of starting Claude this machine has: {desktop, terminal, cli}. */
export function launchOptions() {
  const terminal = process.platform === 'darwin' || (process.platform === 'linux' && Boolean(onPath('x-terminal-emulator')));
  return { desktop: Boolean(desktopApp()), terminal, cli: claudeRunnable() };
}

export function desktopUrl(text, folder) {
  const q = new URLSearchParams();
  if (folder) q.append('folder', folder);
  q.set('q', text);
  return `claude://code/new?${q}`;
}

export const continueUrl = (host) => `claude://code/continue?session=${encodeURIComponent(host)}`;

/** A shell word: single quotes, and every single quote inside closed, escaped and reopened. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** An AppleScript string literal. */
export const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_VAR = 'CLAUDE_CODE_EFFORT_LEVEL';
/** Check an effort level of a start; the error text for a 400, or null. */
export const effortProblem = (effort) => (effort !== undefined && !EFFORT_LEVELS.includes(effort) ? `effort: one of ${EFFORT_LEVELS.join(', ')}` : null);

export function terminalCommand({ text, resume, folder, session, url, effort, bin = 'claude' }) {
  const cd = folder ? `cd ${shellQuote(folder)} && ` : '';
  const level = EFFORT_LEVELS.includes(effort) ? `${EFFORT_VAR}=${effort} ` : '';
  const env = `${url ? `KB_URL=${shellQuote(url)} ` : ''}env -u CLAUDE_CODE_SIMPLE ${level}`;
  if (resume) return `${cd}${env}${bin} --resume ${shellQuote(resume)}`;
  return `${cd}${env}${bin} ${session ? `--session-id ${shellQuote(session)} ` : ''}${shellQuote(text)}`;
}

/** What to run for a launch: `{cmd, args}` — never a shell line put together from the request. */
export function launchSpec({ mode, text, folder, resume, host, session, url, effort, bin }, platform = process.platform) {
  if (mode === 'desktop') {
    if (platform !== 'darwin') throw Object.assign(new Error('the Claude app is opened this way only on macOS'), { statusCode: 501 });
    return { cmd: 'open', args: [host ? continueUrl(host) : desktopUrl(text, folder)] };
  }
  return windowSpec(terminalCommand({ text, resume, folder, session, url, effort, bin }), platform, 'the prompt');
}

/** A new terminal window running the shell `line`: `{cmd, args}`. `then` — what goes between the line and the shell the
    window keeps (Linux). */
function windowSpec(line, platform, what, then = '; ') {
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script ${appleString(line)}`, '-e', 'tell application "Terminal" to activate'] };
  }
  if (platform === 'linux') return { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', `${line}${then}exec bash`] };
  throw Object.assign(new Error(`no terminal to open on this system — copy ${what} instead`), { statusCode: 501 });
}

/** What to run for a command of the chat: `{cmd, args}`; `lang` — the language of its block. */
export const commandSpec = ({ code, folder, lang }, platform = process.platform) => windowSpec(
  `${folder ? `cd ${shellQuote(folder)} && ` : ''}${lang === 'zsh' ? 'zsh' : 'bash'} -c ${shellQuote(code)}`, platform, 'the command', '\n',
);

const TASK_KEY_RE = /^[A-Za-z0-9]+-\d+$/;
const KEYS_MAX = 100;
/** Check the keys of the tasks a prompt names (any way of starting Claude); the error text for a 400, or null. */
export function keysProblem(keys) {
  if (keys !== undefined && (!Array.isArray(keys) || !keys.length || keys.length > KEYS_MAX || keys.some((k) => typeof k !== 'string' || !TASK_KEY_RE.test(k)))) {
    return 'keys: the keys of the tasks the prompt names';
  }
  return null;
}

/** Check a launch request; returns the error text for a 400, or null. */
export function launchProblem({ mode, text, resume, host, keys, effort }) {
  if (mode !== 'desktop' && mode !== 'terminal') return 'mode: board, desktop or terminal';
  if (effort !== undefined && mode === 'desktop') return 'effort: the Claude app takes no effort level from its link';
  const level = effortProblem(effort);
  if (level) return level;
  if (keys !== undefined && (resume !== undefined || host !== undefined)) return 'keys: only with a prompt — a session is opened as it is';
  const bad = keysProblem(keys);
  if (bad) return bad;
  if (host !== undefined) {
    if (mode !== 'desktop' || typeof host !== 'string' || !HOST_SESSION_RE.test(host)) return 'host: a Claude app session id (local_…), for the app only';
    return null;
  }
  if (resume !== undefined) {
    if (mode !== 'terminal' || typeof resume !== 'string' || !SESSION_ID_RE.test(resume)) return 'resume: a Claude Code session id, for the terminal only';
    return null;
  }
  if (typeof text !== 'string' || !text.trim()) return 'text: the prompt to start with';
  if (text.length > PROMPT_MAX) return `text: at most ${PROMPT_MAX} characters`;
  if (text.includes('\0')) return 'text: no NUL characters';
  return null;
}

export function runLaunch(spec) {
  return new Promise((resolve) => {
    execFile(spec.cmd, spec.args, { timeout: 15000 }, (err, out, errOut) => resolve({ err, text: `${out || ''}${errOut || ''}`.trim() }));
  });
}
