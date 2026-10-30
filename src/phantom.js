
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCli, claudeRunnable, EFFORT_VAR, effortProblem, keysProblem, onPath } from './launch.js';
import { SESSION_ID_RE } from './claude-sessions.js';
import { db, logError } from './db.js';
import { claudeConfigFile, DATA_DIR, tmuxSocket } from './config.js';
import { readRegistry, stateOf, screenState } from './claude-live.js';
import { waitsOwnWork } from './own-wait.js';
import { clearKeys, inField, promptBox, tallBox, undim } from './prompt-box.js';
import { HOOK_TIMEOUT_S, hookCommand, isOurs } from './claude-hooks.js';
import { boardKb, readSettings } from './claude-settings.js';

/** Permission modes the board offers for a background start; never one that skips the checks. */
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'manual', 'plan'];
const KB_SAFE = ['ls', 'p', 'next', 'show', 'info', 'take', 'review', 'note', 'check', 'uncheck', 'add', 'link', 'unlink', 'block', 'unblock', 'pri', 'lbl', 'desc', 'svc', 'sync', 'retry'];
export const MV_SAFE = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review'];
export const BOARD_ALLOWED = [...KB_SAFE.flatMap((c) => [`Bash(kb ${c})`, `Bash(kb ${c} *)`]), ...MV_SAFE.map((s) => `Bash(kb mv * ${s})`)];
/** Keys a card may press in its session, beside typing text. */
export const KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'BSpace', 'C-c']);
export const REPLY_MAX = 14336;
export const COLS = 45;
export const COLS_MIN = 20;
export const COLS_MAX = 300;
const ROWS = 40;
const SCREEN_LINES = 1000;
// the web addresses are read from the newest lines of the joined copy, the sign-in one of /login among them
const LINK_LINES = 200;
const TMUX_PLACES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

export const tmuxBin = () => onPath('tmux') || TMUX_PLACES.find((p) => existsSync(p)) || null;
export { claudeCli };
export const phantomAvailable = () => Boolean(tmuxBin() && claudeRunnable());
export const sessionName = (sid) => `kb-${sid}`;

/** One argument for tmux, read back exactly: a trailing `;` would end the command there. */
export const tmuxArg = (s) => {
  const v = String(s);
  return v.endsWith(';') ? `${v.slice(0, -1)}\\;` : v;
};
/** argv for one tmux call running these commands in turn: [[cmd, ...args], ...]. */
export const tmuxArgv = (commands) => ['-L', tmuxSocket(), ...commands.flatMap((c, i) => [...(i ? [';'] : []), ...c.map(tmuxArg)])];

// What a terminal of the person has: who and where they are, the language, the ssh agent, proxies, certificates.
const KEEP = /^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|TMUX_TMPDIR|TZ|LANG|LANGUAGE|LC_\w+|TERM|COLORTERM|SSH_AUTH_SOCK|EDITOR|VISUAL|PAGER|__CF_USER_TEXT_ENCODING|COMMAND_MODE|XDG_\w+|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|(HTTP|HTTPS|NO|ALL|FTP)_PROXY|(http|https|no|all|ftp)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
// The person's own settings for Claude: an API key, Bedrock or Vertex, a config folder of their own.
const OWN = /^(ANTHROPIC_\w+|CLAUDE_CODE_\w+|CLAUDE_CONFIG_DIR|AWS_\w+|GOOGLE_\w+|CLOUD_ML_REGION|VERTEX_REGION_\w+|DISABLE_\w+|MAX_THINKING_TOKENS|BASH_DEFAULT_TIMEOUT_MS|BASH_MAX_TIMEOUT_MS)$/;
export const DEFAULT_LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
export const NOT_FOR_BOARD = ['CLAUDE_CODE_SIMPLE'];
/** The environment of a terminal of the person, not of the board's process. Their own settings for Claude
    pass too — unless the board was started from inside a Claude session: then they are that session's. */
export function cleanEnv(env = process.env) {
  const fromSession = Boolean(env.CLAUDECODE);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (KEEP.test(k) || (!fromSession && OWN.test(k) && !NOT_FOR_BOARD.includes(k))) out[k] = v;
  if (!out.LANG) out.LANG = DEFAULT_LANG;
  return out;
}

export const KB_BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url));
export const boardPath = (path = cleanEnv().PATH) => (path ? `${KB_BIN_DIR}:${path}` : KB_BIN_DIR);
const launchEnv = () => { const env = cleanEnv(); return { ...env, PATH: boardPath(env.PATH) }; };

function run(cmd, args, cwd, timeout = 8000, env = cleanEnv(), input = undefined) {
  return new Promise((resolve) => {
    if (!cmd) { resolve({ err: new Error('tmux is not installed'), out: '', text: '' }); return; }
    const child = execFile(cmd, args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, out, errOut) => resolve({ err, out: String(out || ''), text: `${out || ''}${errOut || ''}`.trim() }));
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // tmux gave up before reading it: its own answer says why
      child.stdin.end(input);
    }
  });
}
const tmux = (...commands) => run(tmuxBin(), tmuxArgv(commands));
export const TMUX_COMMAND_MAX = 16364;
/** How many bytes of that message an argv for tmuxArgv takes. */
export const tmuxCommandBytes = (args) => (args[0] === '-L' ? args.slice(2) : args).reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);

/** Claude Code asks whether to trust a folder it has not worked in, or under, before; the board says so. */
export function folderTrusted(folder) {
  let projects;
  try { projects = JSON.parse(readFileSync(claudeConfigFile(), 'utf8')).projects || {}; } catch { return false; }
  for (let dir = folder; dir; dir = dirname(dir) === dir ? null : dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}

/** Check a request to start Claude inside the board; returns the error text for a 400, or null. */
export function boardProblem({ keys, permission, resume, host, effort, text }) {
  if (host !== undefined) return 'board: starts new work; a running session is answered from its card';
  if (resume !== undefined && (typeof resume !== 'string' || !SESSION_ID_RE.test(resume) || text !== undefined)) {
    return 'resume: the id of a board session of these tasks, without a prompt';
  }
  const bad = keysProblem(keys);
  if (bad) return bad;
  if (permission !== undefined && !PERMISSION_MODES.includes(permission)) return `permission: one of ${PERMISSION_MODES.join(', ')}`;
  return effortProblem(effort);
}

export const NO_SUGGESTIONS = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false';
export const NO_ALT_SCREEN = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1';
export function askHook(port, read = readSettings, write = writeAskHook) {
  let list;
  try { list = read().settings?.hooks?.PermissionRequest; } catch { list = undefined; }
  if (Array.isArray(list) && list.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurs(h?.command, 'hook')))) return [];
  const hook = { type: 'command', command: hookCommand(boardKb(`http://127.0.0.1:${port}`)), timeout: HOOK_TIMEOUT_S };
  const text = JSON.stringify({ hooks: { PermissionRequest: [{ matcher: 'AskUserQuestion', hooks: [hook] }] } });
  let path = null;
  try { path = write(port, text); } catch (e) { logError('server', 'phantom', `the hook of questions went as text: ${e.message}`); }
  return ['--settings', path || text];
}
let hookWrites = 0;
/** The settings of the hook for the board on `port`, in its data: written whole (a temporary file and one rename — a
    Claude starting meanwhile never reads half of it); the path. */
export function writeAskHook(port, text) {
  const path = join(DATA_DIR, `ask-hook-${port}.json`);
  const part = `${path}.${process.pid}.${++hookWrites}.part`;
  try {
    writeFileSync(part, `${text}\n`, { mode: 0o600 });
    renameSync(part, path);
  } catch (e) { rmSync(part, { force: true }); throw e; }
  return path;
}

export const SERVER_START = [['start-server'], ['set-option', '-s', 'exit-empty', 'off']];
export function phantomSpec({ sid, name, text, folder, permission = 'auto', port, allow = [], effort, read, resume = false }) {
  const level = effort ? ['-e', `${EFFORT_VAR}=${effort}`] : [];
  return {
    cmd: tmuxBin(),
    cwd: folder,
    start: tmuxArgv(SERVER_START),
    args: tmuxArgv([
      ['set-option', '-s', 'exit-empty', 'on'],
      ['set-option', '-g', 'remain-on-exit', 'on'],
      // terminal; it lives on while any of its sessions does, remain-on-exit) passed it to every Claude ▶ started after
      ...NOT_FOR_BOARD.map((k) => ['set-environment', '-g', '-u', k]),
      ['new-session', '-d', '-s', sessionName(sid), '-x', String(COLS), '-y', String(ROWS), '-e', `KB_URL=http://127.0.0.1:${port}`, '-e', `LANG=${cleanEnv().LANG}`, '-e', NO_SUGGESTIONS, '-e', NO_ALT_SCREEN, ...level,
        '--', claudeCli(), ...askHook(port, read), '--allowedTools', ...BOARD_ALLOWED, ...allow, '--permission-mode', permission, '--name', name, ...(resume ? ['--resume', sid] : ['--session-id', sid, text])],
    ]),
  };
}
const SERVER_GONE = /server exited unexpectedly|lost server/i;
export async function runPhantom(spec) {
  const go = async () => {
    if (spec.start) await run(spec.cmd, spec.start, spec.cwd, 15000, launchEnv());
    return run(spec.cmd, spec.args, spec.cwd, 15000, launchEnv());
  };
  const first = await go();
  if (!first.err || !SERVER_GONE.test(first.text)) return first;
  await new Promise((r) => { setTimeout(r, 200); });
  return go();
}

const pane = (sid) => `=${sessionName(sid)}:`; // `=` — this very session, not one whose name starts so

const STATE_FORMAT = '#{pane_dead}|#{pane_dead_status}|#{window_width}|#{pane_pid}|#{pid}|#{pane_dead_signal}';
function paneState(line) {
  const [dead, status, width, pid, server, signal] = line.trim().split('|');
  const at = { cols: Number(width) || null, pid: Number(pid) || null, server: Number(server) || null };
  if (dead !== '1') return { dead: false, ...at };
  return { dead: true, exit: status === undefined || status === '' ? null : Number(status), signal: signal ? Number(signal) || signal : null, ...at };
}
/** The pane's Claude was stopped from outside (a signal), not ended by itself or by /exit. */
export function endedBySignal(st) { return Boolean(st?.dead && (st.signal || st.exit >= 128)); }
const readState = async (sid) => {
  const r = await tmux(['list-panes', '-t', pane(sid), '-F', STATE_FORMAT]);
  return r.err ? null : paneState(r.out);
};

const nudged = new Set();
export async function nudgeLostExit(sid, st, read, kill = process.kill.bind(process)) {
  if (!st?.dead || st.exit !== null || !st.server || nudged.has(sid)) return st; // a named signal too: one nudge is harmless, and on the Mac only such a pane shows that it reaches the server
  nudged.add(sid);
  try { kill(st.server, 'SIGCHLD'); } catch { return st; }
  await pause(150);
  return (await read()) || st;
}

/** {dead, exit, cols, pid, server} of the session's pane — dead: Claude has exited, the pane keeps its last
    screen; cols: the width of its window; pid: the program in it (Claude itself: tmux runs it without a
    shell); server: the tmux server — or null. */
export async function phantomState(sid) {
  if (!SESSION_ID_RE.test(sid)) return null;
  return nudgeLostExit(sid, await readState(sid), () => readState(sid));
}

const NO_PANE = /can't find (session|window|pane)|no server running|error connecting to|tmux is not installed/i;
/** phantomState for the question "is the board's terminal of this session gone": null only on tmux's own word that
    there is no such session (or no tmux server at all); a tmux that did not answer gives `{dead: false, unknown: true}`. */
export async function phantomPane(sid) {
  if (!SESSION_ID_RE.test(sid)) return null;
  const r = await tmux(['list-panes', '-t', pane(sid), '-F', STATE_FORMAT]);
  if (r.err) return NO_PANE.test(`${r.text} ${r.err.message}`) || SERVER_GONE.test(r.text) ? null : { dead: false, unknown: true };
  return nudgeLostExit(sid, paneState(r.out), () => readState(sid));
}

export const phantomResize = (sid, cols) => tmux(['resize-window', '-t', pane(sid), '-x', String(cols), '-y', String(ROWS)]);

/** What the session's screen shows now, with the scrollback above it — row by row, as the terminal shows
    it: joined (`-J`), a long path the screen wrapped became one line and pushed the card sideways. */
export async function phantomScreen(sid, lines = SCREEN_LINES, { escapes = false } = {}) {
  const r = await tmux(['capture-pane', '-p', ...(escapes ? ['-e'] : []), '-S', `-${lines}`, '-t', pane(sid)]);
  return r.err ? null : r.out.replace(/\s+$/, '');
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const LINKS_MAX = 4;
/** The web addresses on the screen, whole — the newest last. The screen wraps a long one over several rows
    (the sign-in address of /login is ~400 characters), and copied from there it comes with line breaks in
    it; the joined capture (`-J`) has it in one piece, so the card can make it a link. */
function linksIn(joined) {
  const found = (joined.match(URL_RE) || []).map((u) => u.replace(/[).,;:!?\]}>'"]+$/, ''));
  return [...new Set(found.reverse())].slice(0, LINKS_MAX).reverse();
}

/** The rows of `screen` (both captured from the same line) that go on the row above them — the ones tmux wrapped
    itself: a joined line of `joined` is its rows one after the other, the spaces trimmed off the end of a row in
    between. On anything that does not match, the rows found so far. */
export function wrapsIn(screen, joined) {
  const raw = screen.split('\n');
  const wraps = [];
  let i = 0;
  for (const line of joined.split('\n')) {
    if (i >= raw.length) break;
    let rest = line.replace(/ +$/, '');
    if (!rest.startsWith(raw[i])) break;
    rest = rest.slice(raw[i].length);
    i++;
    while (rest) {
      if (i >= raw.length) return wraps;
      const r = raw[i];
      let k = 0;
      while (!rest.startsWith(r, k) && rest[k] === ' ') k++;
      if (!rest.startsWith(r, k)) return wraps;
      wraps.push(i);
      rest = rest.slice(k + r.length);
      i++;
    }
  }
  return wraps;
}

export async function phantomView(sid, lines = SCREEN_LINES) {
  if (!SESSION_ID_RE.test(sid)) return null;
  const cut = `kb-cut-${randomUUID()}`;
  const mark = ['display-message', '-p', '-t', pane(sid), cut];
  const r = await tmux(['list-panes', '-t', pane(sid), '-F', STATE_FORMAT], mark,
    ['capture-pane', '-p', '-S', `-${lines}`, '-t', pane(sid)], mark,
    ['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', pane(sid)]);
  if (r.err) return null;
  const [state, screen, joined] = r.out.split(`${cut}\n`);
  if (joined === undefined) return null;
  const st = await nudgeLostExit(sid, paneState(state), () => readState(sid));
  const text = screen.replace(/\s+$/, '');
  const rows = text.split('\n').length;
  return { ...st, screen: text, wraps: wrapsIn(screen, joined).filter((i) => i < rows),
    links: linksIn(joined.split('\n').slice(-(LINK_LINES + ROWS)).join('\n')) };
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
let bufNo = 0;
/** Put text into the pane. `bracketed` — the way a terminal pastes it (`-p`), line breaks kept as LF (`-r`):
    typed, or pasted as CR, every line break would be an Enter and send the first line on its own. Without
    it the program gets the very bytes `send-keys -l` would type. */
async function pasteText(sid, text, bracketed = true) {
  const buf = `${sessionName(sid)}-${++bufNo}`;
  const r = await run(tmuxBin(), tmuxArgv([['load-buffer', '-b', buf, '-'], ['paste-buffer', ...(bracketed ? ['-p'] : []), '-r', '-d', '-b', buf, '-t', pane(sid)]]),
    undefined, 8000, cleanEnv(), text.replace(/\r\n?/g, '\n'));
  if (r.err) await tmux(['delete-buffer', '-b', buf]); // the pane is gone: the text does not stay in tmux
  return r;
}
export const IMAGE_PASTE_GAP_MS = 300;
export async function phantomSend(sid, { text, key, paste = false, images = [] }) {
  for (const path of images) {
    const r = await pasteText(sid, path, true);
    if (r.err) return r;
    await pause(IMAGE_PASTE_GAP_MS);
  }
  if (typeof text === 'string' && text) {
    const r = await pasteText(sid, text, paste || /[\r\n]/.test(text));
    if (r.err) return r;
    if (key) await pause(150); // text and an Enter read in one go are taken for a paste with a line break
  }
  if (key) return tmux(['send-keys', '-t', pane(sid), key]);
  return { err: null };
}

export const DELIVER_WAIT_MS = 3000;
const LOOK_EVERY_MS = 150;
let deliverWait = DELIVER_WAIT_MS;
/** Tests: how long the board waits for the field. */
export function setDeliverWait(ms) { deliverWait = ms; }
const FIELD_HISTORY = 200;
const rowsOf = (out) => out.replace(/\n$/, '').split('\n').map(undim);
async function fieldNow(sid) {
  const r = await tmux(['capture-pane', '-p', '-e', '-t', pane(sid)]);
  if (r.err) return { err: r.err, text: r.text };
  const box = promptBox(r.out.replace(/\s+$/, '').split('\n').map(undim));
  if (box) return { box };
  const h = await tmux(['capture-pane', '-p', '-e', '-S', `-${FIELD_HISTORY}`, '-t', pane(sid)]);
  return { box: h.err ? null : tallBox(rowsOf(h.out), rowsOf(r.out).length) };
}
export async function fieldEmpty(sid) {
  const f = await fieldNow(sid);
  if (f.err) return null;
  return Boolean(f.box) && !f.box.text;
}
async function fieldUntil(sid, ok) {
  const end = Date.now() + deliverWait;
  for (;;) {
    const f = await fieldNow(sid);
    if (f.err || ok(f.box)) return f;
    if (Date.now() >= end) return { ...f, late: true };
    await pause(LOOK_EVERY_MS);
  }
}
/** Type the chat's `text` (and pictures `images`, paths) into Claude's field and send it: {err: null} — sent;
    {refused: 'no-box'|'not-typed'|'not-sent'}; {err, text} — tmux refused. */
export async function deliverChat(sid, { text = '', images = [] }) {
  const first = await fieldNow(sid);
  if (first.err) return first;
  if (!first.box) return { refused: 'no-box' };
  const empty = () => tmux(['send-keys', '-t', pane(sid), ...clearKeys(first.box.rows + Math.ceil(String(text).length / 40))]);
  if (first.box.text) { await empty(); await pause(LOOK_EVERY_MS); }
  const typed = await phantomSend(sid, { text, paste: true, images });
  if (typed.err) return typed;
  const there = await fieldUntil(sid, (box) => box && inField(box.text, text, images));
  if (there.err) return there;
  if (there.late) { await empty(); return { refused: 'not-typed' }; }
  for (let i = 0; i < 2; i++) {
    const r = await tmux(['send-keys', '-t', pane(sid), 'Enter']);
    if (r.err) return r;
    const gone = await fieldUntil(sid, (box) => !box || !inField(box.text, text, images));
    if (gone.err) return gone;
    if (!gone.late) return { err: null };
  }
  return { refused: 'not-sent' };
}

const QUESTION_END = /Esc to (cancel|exit)|Enter to (confirm|select)/;
const BUSY_LINE = /esc to interrupt/i;
const shownLines = (screen) => String(screen || '').split('\n').filter((l) => l.trim());
const lastLines = (screen, n) => shownLines(screen).slice(-n).join(' ').replace(/\s+/g, ' ');
const BOX_BORDER = /^\s*─{8,}/;
function abovePromptBox(lines, under = 4) {
  const bottom = lines.findLastIndex((l) => BOX_BORDER.test(l));
  if (bottom < 0 || lines.length - bottom - 1 > under) return lines;
  let top = bottom - 1;
  while (top >= 0 && !BOX_BORDER.test(lines[top])) top--;
  const inside = bottom - top - 1;
  if (top < 0 || inside < 1 || inside > 8 || !/^\s*❯/.test(lines[top + 1])) return lines;
  return lines.slice(0, top);
}
// above the input box the footer is the very last line (wrapped onto it in a narrow window): a question answered long
// ago stays higher in the scrollback, with Claude's lines after it
function footerLast(lines) {
  const last = (lines.at(-1) ?? '').replace(/\s+/g, ' ').trim();
  const joined = `${lines.at(-2) ?? ''} ${last}`.replace(/\s+/g, ' ');
  const found = [...joined.matchAll(new RegExp(QUESTION_END.source, 'g'))].at(-1);
  return Boolean(last && found && found.index + found[0].length > joined.length - last.length);
}
const OPTION_LINE = /^\s*(❯\s*)?\d+\.\s/;
function optionsAboveFooter(lines) {
  const stop = Math.max(0, lines.length - 4); // the footer (wrapped onto two lines at most) right under the options
  let i = lines.length - 1;
  while (i >= stop && !OPTION_LINE.test(lines[i])) i--;
  if (i < stop) return false;
  // up the list: its options and the lines under them indented deeper than Claude's own text
  for (; i >= 0 && (OPTION_LINE.test(lines[i]) || /^\s{4,}\S/.test(lines[i])); i--) if (/^\s*❯\s*\d+\./.test(lines[i])) return true;
  return false;
}
export const questionOpen = (screen) => {
  const lines = shownLines(screen);
  if (QUESTION_END.test(lastLines(lines.join('\n'), 3))) return true;
  const above = abovePromptBox(lines);
  return above.length < lines.length && footerLast(above) && optionsAboveFooter(above);
};
export const busyOnScreen = (screen) => BUSY_LINE.test(lastLines(screen, 8));

/** Claude Code's registry of live sessions by the pid of the process: {sid, status, alive, …}. */
async function registryByPid() {
  const out = new Map();
  for (const [sid, e] of await readRegistry()) if (e.alive && Number.isInteger(e.pid)) out.set(e.pid, { sid, ...e });
  return out;
}

/** Whether the Claude of a session waits at its prompt: 'idle' — or why not: 'question', 'busy', 'gone'. */
export async function claudeAtPrompt(sid) {
  const st = await phantomState(sid);
  if (!st || st.dead) return 'gone';
  const screen = (await phantomScreen(sid)) ?? '';
  if (questionOpen(screen)) return 'question';
  const now = st.pid ? (await registryByPid()).get(st.pid) : null;
  if (now) {
    const st = screenState(now, { over: turnOverOnScreen(screen) });
    return st === 'idle' || st === 'background' ? 'idle' : st === 'waiting' ? 'question' : 'busy';
  }
  return busyOnScreen(screen) ? 'busy' : 'idle';
}

/** What the Claude in a live board terminal does: 'busy', 'background', 'question', 'limit' or 'idle'. `pid` — the
    program in its pane (the registry is read by it: after /clear the session id of the same Claude is new). */
export async function terminalActivity(pid, screen, claudes = null, ownWork = waitsOwnWork) {
  if (questionOpen(screen)) return 'question';
  if (limitOnScreen(screen)) return 'limit';
  const now = pid ? (claudes || await registryByPid()).get(pid) : null;
  const st = now ? screenState(now, { over: turnOverOnScreen(screen) }) : (busyOnScreen(screen) ? 'busy' : 'idle');
  if (st === 'waiting') return 'question';
  if (st === 'background' || (st === 'idle' && backgroundOnScreen(screen))) {
    return now?.sid && (await ownWork(now.sid)) ? 'own' : 'background';
  }
  return st === 'idle' ? 'idle' : 'busy';
}

/** A message to Claude in the session: pasted after the task's key and sent — only while Claude waits at its
    prompt. {refused: why} otherwise; nothing is typed then, except when a question opened in the moment
    between the paste and the Enter (`typed: true` — the text waits in Claude's input). */
export async function phantomMessage(sid, key, text) {
  const why = await claudeAtPrompt(sid);
  if (why !== 'idle') return { refused: why };
  const r = await pasteText(sid, `${key}: ${text}`);
  if (r.err) return r;
  await pause(150);
  if (questionOpen((await phantomScreen(sid)) ?? '')) return { refused: 'question', typed: true };
  return tmux(['send-keys', '-t', pane(sid), 'Enter']);
}

export const phantomStop = (sid) => tmux(['kill-session', '-t', `=${sessionName(sid)}`]);

const OUT_OF_PLAY = new Set(['done', 'cancelled']);
const SWEEP_EVERY_MS = 2 * 60_000;
export const RESTING_MAX_MS = 6 * 3600_000;
let restingMax = RESTING_MAX_MS;
/** For a test: how long a terminal with no task at work rests before it closes. */
export function setRestingMax(ms) { restingMax = ms; }
const AT_WORK = new Set(['prep', 'doing', 'deploy']);
export const LOOK_HOLD_MS = 5 * 60_000;
let lookHold = LOOK_HOLD_MS;
/** For a test: how long a look of the card keeps a terminal from resting. */
export function setLookHold(ms) { lookHold = ms; }
const looked = new Map(); // sid → ms of the card's last look at its terminal
/** The card looked at the terminal of a session (GET …/terminal). */
export function noteLook(sid) { looked.set(sid, Date.now()); }
const lookedLately = (sid) => Date.now() - (looked.get(sid) ?? -Infinity) < lookHold;

export const ASK_FRESH_MS = 3000;
export const CHAT_COLS = 72;
const asked = new Map(); // sid → Map(width → ms of its last ask)
/** Whether a terminal of `sid` is on a screen: a viewer asked for its width just now. */
export const watched = (sid, now = Date.now()) => [...(asked.get(sid)?.values() ?? [])].some((at) => now - at <= ASK_FRESH_MS);
/** The width to lay the window of `sid` out to, now that a viewer asked for `cols`. */
export function widthFor(sid, cols, now = Date.now()) {
  let widths = asked.get(sid);
  if (!widths) asked.set(sid, widths = new Map());
  widths.set(cols, now);
  let min = cols;
  for (const [w, at] of widths) {
    if (now - at > ASK_FRESH_MS) widths.delete(w);
    else if (w < min) min = w;
  }
  return min;
}

const seenDead = new Map(); // sid → ms the board first saw its pane dead with no time from tmux
/** The sessions on the board's tmux socket with the pid of the program in each: [{sid, pid, dead, deadAt}] — deadAt:
    when Claude in a dead pane exited (ms), or null. */
async function socketPanes() {
  const r = await tmux(['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}|#{pane_dead}|#{pane_dead_time}']);
  if (r.err) return []; // no tmux server on the socket: nothing runs
  const out = [];
  for (const line of r.out.split('\n')) {
    const [name, pid, dead, deadTime] = line.trim().split('|');
    const sid = /^kb-(.+)$/.exec(name || '')?.[1];
    if (!sid || !SESSION_ID_RE.test(sid)) continue;
    let deadAt = dead === '1' ? Number(deadTime) * 1000 || null : null;
    if (dead === '1' && !deadAt) {
      if (!seenDead.has(sid)) seenDead.set(sid, Date.now());
      deadAt = seenDead.get(sid);
    }
    out.push({ sid, pid: Number(pid) || null, dead: dead === '1', deadAt });
  }
  for (const sid of seenDead.keys()) if (!out.some((p) => p.sid === sid && p.dead)) seenDead.delete(sid);
  return out;
}

/** The visible screens of the sessions in one call to tmux, split by a mark no screen can show: Map sid → screen
    (a session that closed in between is missing), or null when tmux did not answer. */
async function captureScreens(sids) {
  if (!sids.length) return new Map();
  const cut = `kb-cut-${randomUUID()}`;
  const r = await tmux(...sids.flatMap((sid) => [['display-message', '-p', cut], ['capture-pane', '-p', '-t', pane(sid)]]));
  if (r.err) return null;
  const parts = r.out.split(`${cut}\n`).slice(1);
  return new Map(sids.map((sid, i) => [sid, parts[i]]).filter(([, screen]) => screen !== undefined));
}

let sweeping = Promise.resolve();
/** Close the board's terminals none of whose tasks is in play anymore. Returns the ids of the sessions closed. */
export function closeFinishedTerminals() {
  const sweep = sweeping.then(sweepOnce, sweepOnce);
  sweeping = sweep.catch(() => {});
  return sweep;
}
async function sweepOnce() {
  const ours = new Set(db.prepare('SELECT session_id FROM board_sessions').all().map((r) => r.session_id));
  if (!ours.size || !tmuxBin()) return [];
  const ties = db.prepare('SELECT t.status FROM task_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.session_id = ?');
  const seen = new Map(); // sid → {play, work}: the statuses of its tasks, read once a sweep
  const tasksOf = (sid) => {
    if (!seen.has(sid)) {
      const st = ties.all(sid).map((r) => r.status);
      seen.set(sid, { play: st.some((x) => !OUT_OF_PLAY.has(x)), work: st.some((x) => AT_WORK.has(x)) });
    }
    return seen.get(sid);
  };
  const panes = (await socketPanes()).filter((p) => ours.has(p.sid) && !tasksOf(p.sid).work);
  if (!panes.length) return [];
  const claudes = await registryByPid();
  const finished = [];
  const resting = [];
  for (const p of panes) {
    const now = p.dead ? null : claudes.get(p.pid);
    if (now && stateOf(now) === 'busy') continue; // in the middle of a turn: the next sweep closes it
    // after /clear the same Claude goes on under a new id: what its tasks are counts too
    const other = now && now.sid !== p.sid ? tasksOf(now.sid) : { play: false, work: false };
    if (other.work) continue;
    if (!tasksOf(p.sid).play && !other.play) { finished.push(p.sid); continue; }
    if (lookedLately(p.sid)) continue;
    if (p.dead) { if (p.deadAt && Date.now() - p.deadAt >= restingMax) finished.push(p.sid); continue; }
    if (now?.since && Date.now() - now.since >= restingMax) resting.push(p);
  }
  const screens = resting.length ? await captureScreens(resting.map((p) => p.sid)) : new Map();
  const rested = [];
  for (const p of resting) {
    const screen = screens?.get(p.sid);
    if (screen !== undefined && (await terminalActivity(p.pid, screen, claudes)) === 'idle') rested.push(p.sid);
  }
  const closed = [];
  for (const sid of [...finished, ...rested]) if (!(await phantomStop(sid)).err) closed.push(sid);
  for (const sid of closed) looked.delete(sid);
  if (closed.length) {
    const n = rested.filter((sid) => closed.includes(sid)).length;
    const why = n ? ` (${n} of them idle for ${Math.round(restingMax / 60_000)} min with no task at work)` : '';
    console.log(`terminal: closed ${closed.length} finished Claude session(s)${why}: ${closed.join(', ')}`);
  }
  return closed;
}

const BACKGROUND = /\b\d+ (?:shells?|background tasks?)\b/;
function underPromptBox(screen) {
  const lines = shownLines(screen);
  const bottom = lines.findLastIndex((l) => BOX_BORDER.test(l)); // the lower edge of the input box
  if (bottom < 0 || lines.length - bottom - 1 > 8) return null;
  // drawn with rules (a permission to edit a file that quotes "Usage limit reached") is no input box: its lines read
  // as the stop, while Claude was asking. The cursor of a list of options (❯ 1. Yes) is no input box either.
  let top = bottom - 1;
  while (top >= 0 && !BOX_BORDER.test(lines[top])) top--;
  const inside = bottom - top - 1;
  if (top < 0 || inside < 1 || inside > 8 || !/^\s*❯(?!\s*\d+\.)/.test(lines[top + 1])) return null;
  return lines.slice(bottom + 1).join(' ').replace(/\s+/g, ' ');
}
export function backgroundOnScreen(screen) {
  const under = underPromptBox(screen);
  return Boolean(under && BACKGROUND.test(under));
}
const TURN_OVER = /\bfor (?:\d+h ?)?(?:\d+m ?)?\d+s · done\b/;
export function turnOverOnScreen(screen) {
  const lines = shownLines(screen);
  // as underPromptBox takes
  const above = abovePromptBox(lines, 8);
  if (above.length === lines.length) return false; // no input box at the bottom: a dialog, or no Claude
  const last = above.at(-1) ?? '';
  if (TURN_OVER.test(last)) return true;
  if (!/^\s{2,}\S/.test(last)) return false; // only an indented line continues the one above it
  return TURN_OVER.test(`${above.at(-2) ?? ''} ${last.trim()}`.replace(/\s+/g, ' '));
}
const SPINNER = /^\s*[·✢✳✶✻✽*]\s.*…\s*\((?:\d+h ?)?(?:\d+m ?)?\d+s(?: · ([^)]*))?/;
const SPINNER_LINES = 14;
const SPINNER_TOKENS = /[↓↑]\s*([\d.]+)\s*([km]?)\s*tokens?/i;
/** What the spinner says: {tokens?, thinking?, compacting?} — null when there is none on the screen. */
export function paceOnScreen(screen) {
  const lines = shownLines(screen);
  const above = abovePromptBox(lines, 8);
  if (above.length === lines.length) return null;
  for (let i = above.length - 1; i >= Math.max(0, above.length - SPINNER_LINES); i--) {
    const joined = `${above[i]} ${(above[i + 1] ?? '').trim()}`;
    const m = SPINNER.exec(joined);
    if (!m) continue;
    const said = m[1] ?? '';
    const n = SPINNER_TOKENS.exec(said);
    return {
      ...(n ? { tokens: Math.round(Number(n[1]) * { '': 1, k: 1e3, m: 1e6 }[n[2].toLowerCase()]) } : {}),
      ...(/\bth(?:inking|ought)\b/.test(said) ? { thinking: true } : {}),
      ...(/compacting/i.test(joined) ? { compacting: true } : {}),
    };
  }
  return null;
}

const LIMIT_HIT = /\b(?:usage|5-hour|weekly|session|opus|sonnet|plan) limit reached|\bhit your (?:[\w-]+ )?limit/i;
// "resets 12:50am", "resets at 3pm", "resets Oct 9 at 10am", "resets Oct 9, 10am"
const LIMIT_RESETS = /resets?(?: at)? ((?:[a-z]{3,9} \d{1,2},? (?:at )?)?\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/i;
export function limitOnScreen(screen) {
  const under = underPromptBox(screen);
  if (!under || !LIMIT_HIT.test(under)) return null;
  const at = LIMIT_RESETS.exec(under)?.[1];
  return { resets: at ? at.replace(/\s+/g, ' ').replace(/ (am|pm)$/i, '$1') : null };
}
export async function boardLook() {
  const none = { live: [], questions: [], background: [], over: [], limited: [] };
  const ours = new Set(db.prepare('SELECT session_id FROM board_sessions').all().map((r) => r.session_id));
  if (!ours.size || !tmuxBin()) return none;
  const r = await tmux(['list-panes', '-a', '-F', '#{session_name}|#{pane_dead}']);
  if (r.err) return NO_PANE.test(`${r.text} ${r.err.message}`) ? none : { ...none, failed: true }; // no server: no terminals
  const live = [];
  for (const line of r.out.split('\n')) {
    const [name, dead] = line.trim().split('|');
    const sid = /^kb-(.+)$/.exec(name || '')?.[1];
    if (sid && ours.has(sid) && dead !== '1') live.push(sid);
  }
  if (!live.length) return none;
  // every screen in one call to tmux (as phantomView does): the watch runs every three seconds, and the owner keeps
  // twenty terminals and more
  const screens = await captureScreens(live);
  if (!screens) return { ...none, failed: true }; // a session closed in between: the next look sees the rest
  const out = { live: [], questions: [], background: [], over: [], limited: [] };
  live.forEach((sid) => {
    const screen = screens.get(sid);
    if (screen === undefined) return;
    out.live.push(sid);
    if (questionOpen(screen)) out.questions.push(sid);
    if (backgroundOnScreen(screen)) out.background.push(sid);
    if (turnOverOnScreen(screen)) out.over.push(sid);
    const hit = limitOnScreen(screen);
    if (hit) out.limited.push({ sid, resets: hit.resets });
  });
  return out;
}
/** The board's own live terminals with a question open on their screen: [sid]. */
export async function boardQuestions() { return (await boardLook()).questions; }

/** Sessions this board started before it kept board_sessions: one on its socket that is tied to its tasks
    is its own. Only at the start of the board itself, never on a request — a test's database must never
    claim a session of the live socket. */
export async function adoptBoardTerminals() {
  if (!tmuxBin()) return 0;
  const tied = db.prepare('SELECT 1 FROM task_sessions WHERE session_id = ? LIMIT 1');
  const add = db.prepare('INSERT OR IGNORE INTO board_sessions (session_id) VALUES (?)');
  let n = 0;
  for (const p of await socketPanes()) if (tied.get(p.sid)) n += add.run(p.sid).changes;
  return n;
}

export function startTerminalSweep() {
  const fail = (e) => logError('server', 'terminal', `closing finished terminals failed: ${e.message}`);
  const sweep = () => closeFinishedTerminals().catch(fail);
  setInterval(sweep, SWEEP_EVERY_MS).unref();
  return adoptBoardTerminals().then(sweep, fail);
}

/** The board's session that works on a task: the newest one the board started and tmux still has — or null.
    `screen` — with what its screen shows (`screen`, `links`), in the same call to tmux. `strict` — a tmux that did
    not answer is no answer: `{session, unknown: true}` instead of going on to the next session. */
export async function taskTerminal(taskId, { screen = false, strict = false } = {}) {
  if (!tmuxBin()) return null;
  const rows = db.prepare(`SELECT s.session_id FROM task_sessions s JOIN board_sessions b ON b.session_id = s.session_id
    WHERE s.task_id = ? ORDER BY s.last_seen DESC, s.first_seen DESC LIMIT 5`).all(taskId);
  for (const r of rows) {
    const st = screen ? await phantomView(r.session_id) : strict ? await phantomPane(r.session_id) : await phantomState(r.session_id);
    if (st?.unknown) return { session: r.session_id, unknown: true };
    if (st) {
      return { session: r.session_id, dead: st.dead, ...(st.dead ? { exit: st.exit, interrupted: endedBySignal(st) } : {}), cols: st.cols,
        ...(screen ? { screen: st.screen, wraps: st.wraps, links: st.links } : {}),
        ...(screen && !st.dead ? { activity: await terminalActivity(st.pid, st.screen) } : {}) };
    }
  }
  return null;
}
