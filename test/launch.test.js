// (`claude '<prompt>'`), or by copying the prompt. The server opens it, so the quoting is pinned here
// against a real shell and a real osascript, with text written to break out of its quotes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Fastify from 'fastify';
import { boardOnly, effortOf, startEffort, checksOnly, launchPick, withBoardAddress } from '../public/js/launch-rules.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const NASTY = [
  `it's "quoted" $(touch /tmp/kb-pwned) \`whoami\` ; echo x & | > < \\ \\n`,
  'Run the kanban skill\nÜnïcödé — 日本語 ✓\nSIT-1\nSIT-2',
  "line one\r\nline 'two'\n\n  indented\ttab ✓",
];
let app, tmp, folder, launch, db, base;

let savedHome;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  // empty one here, so the commands name the `claude` of the test's PATH, as they do on a machine where it is on PATH
  savedHome = process.env.HOME; process.env.HOME = join(tmp, 'home');
  folder = realpathSync(mkdtempSync(join(tmpdir(), "kb-folder-it's ")));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LAUNCH_DRYRUN = '1';
  process.env.PORT = '3177';
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  launch = await import('../src/launch.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('site','SIT','Site',3,?)").run(folder);
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('gone','GON','Gone',1,'/nowhere/at/all')").run();
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('bare','BAR','Bare',1)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='site'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Fix the header','todo')").run(pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,2,'In work','todo')").run(pid);
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  delete process.env.PORT;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('a shell word survives a real shell byte for byte, whatever is inside it', () => {
  for (const s of NASTY) {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${launch.shellQuote(s)}`]).toString();
    assert.equal(out, s);
  }
});

test('the terminal line starts claude in the project folder with exactly the prompt', () => {
  // a stand-in for claude that prints where it runs and what it was given
  const bin = mkdtempSync(join(tmpdir(), 'kb-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\npwd\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
  chmodSync(join(bin, 'claude'), 0o755);
  try {
    for (const text of NASTY) {
      const out = execFileSync('/bin/sh', ['-c', launch.terminalCommand({ text, folder })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
      assert.equal(out, `${folder}\n[${text}]`);
    }
    const resumed = execFileSync('/bin/sh', ['-c', launch.terminalCommand({ resume: '44444444-4444-4444-8444-444444444444', folder })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString();
    assert.equal(resumed, `${folder}\n[--resume][44444444-4444-4444-8444-444444444444]`);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('an AppleScript string reads back as the same text in a real osascript', { skip: process.platform !== 'darwin' && 'osascript is macOS only' }, () => {
  for (const s of NASTY) {
    const out = execFileSync('osascript', ['-e', `return ${launch.appleString(s)}`]).toString();
    // osascript ends its answer with one newline of its own; everything before it is the text, byte for byte
    assert.equal(out.replace(/\n$/, ''), s);
  }
});

test('the app link carries the prompt and the folder the way the app reads them', () => {
  const spec = launch.launchSpec({ mode: 'desktop', text: NASTY[0], folder }, 'darwin');
  assert.equal(spec.cmd, 'open');
  assert.equal(spec.args.length, 1, 'one argument to open, not a line for a shell');
  const url = new URL(spec.args[0]);
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'claude://code/new');
  assert.equal(url.searchParams.get('q'), NASTY[0]);
  assert.deepEqual(url.searchParams.getAll('folder'), [folder]);
  assert.equal(launch.launchSpec({ mode: 'desktop', host: 'local_ab-12' }, 'darwin').args[0], 'claude://code/continue?session=local_ab-12');
  assert.throws(() => launch.launchSpec({ mode: 'desktop', text: 'x' }, 'linux'), /only on macOS/);
  assert.equal(launch.launchSpec({ mode: 'terminal', text: 'x', folder }, 'linux').cmd, 'x-terminal-emulator');
  assert.throws(() => launch.launchSpec({ mode: 'terminal', text: 'x' }, 'win32'), /no terminal/);
});

test('a launch request is checked before anything runs', () => {
  const p = launch.launchProblem;
  assert.equal(p({ mode: 'desktop', text: 'Do SIT-1' }), null);
  assert.match(p({ mode: 'shell', text: 'x' }), /mode/);
  assert.match(p({ mode: 'desktop', text: '' }), /text/);
  assert.match(p({ mode: 'desktop', text: 'x'.repeat(launch.PROMPT_MAX + 1) }), /at most/);
  assert.match(p({ mode: 'desktop', text: 'a\0b' }), /NUL/);
  assert.match(p({ mode: 'terminal', host: 'local_ab' }), /host/, 'an app session cannot be opened in a terminal');
  assert.match(p({ mode: 'desktop', host: 'local_../../x' }), /host/);
  assert.match(p({ mode: 'desktop', resume: '44444444-4444-4444-8444-444444444444' }), /resume/);
  assert.match(p({ mode: 'terminal', resume: '$(id)' }), /resume/);
});

const post = (body) => app.inject({ method: 'POST', url: '/api/launch', payload: body });

test('the folder comes from the registry: a folder in the request is never used', async () => {
  const r = await post({ mode: 'terminal', text: 'Do SIT-1', project: 'site', folder: '/etc' });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.dry, true);
  assert.equal(j.folder, folder);
  assert.ok(!JSON.stringify(j.args).includes('/etc'), 'the folder named in the request reached the command');
  assert.equal((await post({ mode: 'terminal', text: 'x', project: 'nope' })).statusCode, 404);
  assert.equal((await post({ mode: 'terminal', text: 'x', project: 7 })).statusCode, 400);
  assert.equal((await post({ mode: 'terminal', text: 'x'.repeat(launch.PROMPT_MAX + 1) })).statusCode, 400);
  const options = (await app.inject({ method: 'GET', url: '/api/launch' })).json();
  assert.deepEqual(Object.keys(options).sort(), ['board', 'cli', 'desktop', 'port', 'terminal']);
  assert.equal(options.port, (await import('../src/config.js')).PORT, 'CK-563: the page is not told where the board listens');
});

test('a guest of the Wi-Fi door opens no window on the owner\'s screen: the Terminal and the app are refused', async () => {
  for (const mode of ['terminal', 'desktop']) {
    const r = await app.inject({ method: 'POST', url: '/api/launch', headers: { 'x-kb-guest': '1' }, payload: { mode, text: 'Do SIT-1', project: 'site' } });
    assert.equal(r.statusCode, 403, `${mode}: ${r.body}`);
    assert.equal(r.json().reason, 'guest');
  }
  assert.equal((await post({ mode: 'terminal', text: 'Do SIT-1', project: 'site' })).statusCode, 200); // the owner's own page
});

test('a project without its folder here is refused in every way to start, not started in the home folder', async () => {
  // it — while "inside the board" said honestly that the project has no folder. Now all of them say so
  for (const mode of ['terminal', 'desktop']) {
    for (const [project, missing] of [['gone', '/nowhere/at/all'], ['bare', null]]) {
      const r = await post({ mode, text: 'Do it', project });
      assert.equal(r.statusCode, 409, `${mode}, ${project}: ${r.body}`);
      const j = r.json();
      assert.deepEqual([j.reason, j.project, j.missing, j.dry], ['no-folder', project, missing, undefined], `${mode}, ${project}`);
      assert.equal(j.suggest, join(tmp, 'projects', project), 'the page cannot offer a folder to make');
    }
  }
  const resumed = await post({ mode: 'terminal', resume: '44444444-4444-4444-8444-444444444444', project: 'gone' });
  assert.equal(resumed.statusCode, 409, 'a session is resumed in the home folder');
  // with no project at all (the summary board, tasks of several projects) it starts without a folder, as it did
  const none = await post({ mode: 'terminal', text: 'Do the tasks' });
  assert.equal(none.statusCode, 200, none.body);
  assert.equal(none.json().folder, null);
  // and the page asks for the folder in these ways too, then starts again by itself
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /if \(e\.body\?\.reason === 'no-folder' && body\.text && !again\) \{\n      if \(await askProjectFolder\(e\.body\)\) await postLaunch\(body, btn, true\);/,
    'the Terminal or the app answer no-folder, and the page only shows the English refusal');
});

const kb = (args, env) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: { ...e, ...env } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('kb inside the Claude app also sends the app\'s id of the session, and the card keeps it', async () => {
  const sid = '55555555-5555-4555-8555-555555555555';
  let r = await kb(['mv', 'SIT-1', 'prep'], { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: 'local_1234-abcd' });
  assert.equal(r.code, 0, r.stderr);
  r = await kb(['mv', 'SIT-2', 'prep'], { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: '../../x' });
  assert.equal(r.code, 0, r.stderr);
  const one = (await app.inject({ method: 'GET', url: '/api/tasks/SIT-1' })).json();
  assert.equal(one.sessions[0].host_session, 'local_1234-abcd');
  const two = (await app.inject({ method: 'GET', url: '/api/tasks/SIT-2' })).json();
  assert.equal(two.sessions[0].host_session, null, 'an id that is not the app\'s format is not kept');
  // a later write from the same session without the header (kb run outside the app) does not erase it
  r = await kb(['note', 'SIT-1', 'still here'], { CLAUDE_CODE_SESSION_ID: sid });
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/SIT-1' })).json().sessions[0].host_session, 'local_1234-abcd');
});

test('the column starts Claude with the very prompt its copy button copies', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /export async function copyTodoPrompt\(tasks, btn\) \{\n  const text = promptHere\(todoPromptText\(tasks\)\);/);
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  assert.match(board, /launchInClaude\(\{ text: todoPromptText\(mine\), project, keys: mine\.map\(\(t\) => t\.key\), btn: launch \}\)/,
    'the ▶ on To do builds its own prompt, and the two can drift apart');
  assert.match(board, /copyTodoPrompt\(mine, copy\)/, 'the copy button copies other tasks than ▶ starts');
});

// board that started it: only Claude inside the board was given KB_URL. The Terminal command now carries it; the app
// takes no environment from its link, so for a board on another port the prompt names the address.
test('Claude in the Terminal is given this board\'s address, through a real shell and a real AppleScript string', () => {
  const bin = mkdtempSync(join(tmpdir(), 'kb-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n[ -n "${CLAUDE_CODE_SIMPLE+x}" ] && printf "SIMPLE|"\nprintf "%s|" "$KB_URL"\nfor a in "$@"; do printf "[%s]" "$a"; done\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const url = 'http://127.0.0.1:3177';
  try {
    // .zshrc does not reach Claude (it would print SIMPLE|)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KB_URL: 'http://127.0.0.1:3100', CLAUDE_CODE_SIMPLE: '1' };
    const run = (line) => execFileSync('/bin/sh', ['-c', line], { env }).toString();
    assert.equal(run(launch.terminalCommand({ text: NASTY[0], folder, url })), `${url}|[${NASTY[0]}]`);
    assert.equal(run(launch.terminalCommand({ resume: '44444444-4444-4444-8444-444444444444', folder, url })), `${url}|[--resume][44444444-4444-4444-8444-444444444444]`);
    assert.equal(run(launch.terminalCommand({ text: 'x', folder, session: '44444444-4444-4444-8444-444444444444', url })), `${url}|[--session-id][44444444-4444-4444-8444-444444444444][x]`);
    if (process.platform === 'darwin') {
      // what Terminal is told to run is the same line, quotes and all
      const line = launch.terminalCommand({ text: NASTY[0], folder, url });
      const script = launch.launchSpec({ mode: 'terminal', text: NASTY[0], folder, url }, 'darwin').args[1];
      assert.equal(script, `tell application "Terminal" to do script ${launch.appleString(line)}`);
      assert.equal(execFileSync('osascript', ['-e', `return ${launch.appleString(line)}`]).toString().replace(/\n$/, ''), line);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('a start in the Terminal names the port this board runs on', async () => {
  for (const body of [{ mode: 'terminal', text: 'Do SIT-1', project: 'site' }, { mode: 'terminal', resume: '44444444-4444-4444-8444-444444444444', project: 'site' }]) {
    const r = await post(body);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().args.join(' ').includes("KB_URL='http://127.0.0.1:3177' env -u CLAUDE_CODE_SIMPLE claude "), `no address of the board in ${r.json().args[1]}`);
  }
  // the app's link carries no environment: its prompt is the page's, the address goes in there (below). The Claude app
  // is macOS only — elsewhere the start is refused (the CI runs on Linux)
  if (process.platform !== 'darwin') return;
  const app_ = await post({ mode: 'desktop', text: 'Do SIT-1', project: 'site' });
  assert.equal(new URL(app_.json().args[0]).searchParams.get('q'), 'Do SIT-1');
});

test('the prompt for the app or a copy names the board only when it is not on kb\'s default port', () => {
  const text = 'Run the kanban skill\nDo the task SIT-1';
  assert.equal(withBoardAddress(text, '3100'), text, 'the default port clutters the prompt');
  assert.equal(withBoardAddress(text, ''), text);
  assert.equal(withBoardAddress(text, '3101'), `${text}\nThis board is at http://127.0.0.1:3101, so run kb as KB_URL=http://127.0.0.1:3101 kb …`);
  // in the board's language, as the rest of the prompt
  const dict = { 'This board is at': 'X1', 'so run kb as': 'X2' };
  assert.equal(withBoardAddress(text, 3105, (s) => dict[s] ?? s), `${text}\nX1 http://127.0.0.1:3105, X2 KB_URL=http://127.0.0.1:3105 kb …`);
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const k of Object.keys(dict)) assert.ok(core.includes(`'${k}':`), `no Russian for "${k}"`);
});

test('the page puts the address into the prompt only for the app and a copy — the Terminal and the board get it otherwise', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const piece = (head, end = '\n}\n') => {
    const at = sse.indexOf(head);
    assert.ok(at >= 0, `${head} is gone from sse.js`);
    return sse.slice(at, sse.indexOf(end, at) + end.length).replace(/^export /, '');
  };
  for (const setting of ['board', 'desktop', 'terminal', 'copy']) {
    const posted = [];
    const copied = [];
    const box = {
      api: async (method, path, body) => { if (method === 'POST') posted.push(body); return method === 'GET' ? { board: true, desktop: true, terminal: true, cli: true } : { ok: true, keys: body?.keys }; },
      getSetting: (k) => ({ launch: setting, permission: 'auto' })[k], pickedSetting: (k) => ({ launch: setting, permission: 'auto' })[k], launchPick, boardOnly, effortOf, startEffort, checksOnly, state: {},
      copyText: async (t) => { copied.push(t); return true; }, tr: (s) => s, styledAlert() {}, openTerminalOf() {}, askProjectFolder: async () => false,
      setTimeout: () => 0, ic: () => '', promptHere: (s) => `${s}\n<address>`,
    };
    vm.runInNewContext(['var launchAvail = null;', piece('export async function loadLaunchOptions('), piece('async function launchMode('),
      piece('function flashButton('), piece('async function postLaunch('), piece('const BOARD_WHY = {', '\n};\n'), piece('export async function launchInClaude(')].join('\n'), box);
    const btn = { innerHTML: '', title: '', textContent: '', classList: { toggle() {}, remove() {} } };
    await box.launchInClaude({ text: 'Do SIT-1', project: 'site', keys: ['SIT-1'], btn });
    const sent = setting === 'copy' ? copied : posted.map((b) => b.text);
    const want = setting === 'desktop' || setting === 'copy' ? 'Do SIT-1\n<address>' : 'Do SIT-1';
    assert.deepEqual(sent, [want], `${setting}: the prompt it was given`);
  }
});

// nobody gives KB_URL either — each names this board when it is not on kb's default port, and none does on 3100.
test('the copies of To do and Backlog and the copied resume line name the board, only off kb\'s default port', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const piece = (head, end = '\n}\n') => {
    const at = sse.indexOf(head);
    assert.ok(at >= 0, `${head} is gone from sse.js`);
    return sse.slice(at, sse.indexOf(end, at) + end.length).replace(/^export /, '');
  };
  const line = (port) => `\nThis board is at http://127.0.0.1:${port}, so run kb as KB_URL=http://127.0.0.1:${port} kb …`;
  // Behind a reverse proxy the page's address is the proxy's — https on 443 has no port at all — and the server's word wins
  const cases = [['3101', undefined, '3101'], ['3100', undefined, '3100'], ['', undefined, ''],
    ['', 3105, '3105'], ['8443', 3105, '3105'], ['8443', 3100, '3100'], ['3101', 3101, '3101']];
  for (const [own, listens, port] of cases) {
    const copied = [];
    const box = {
      location: { port: own }, withBoardAddress, KB_DEFAULT_PORT: '3100', ALL: '__all__', state: { slug: 'site' },
      tr: (s) => s, ic: () => '', setTimeout: () => 0, copyText: async (t) => { copied.push(t); return true; },
      api: async () => ({ desktop: false, terminal: false, cli: false, ...(listens ? { port: listens } : {}) }), getSetting: () => 'copy', pickedSetting: () => 'copy', launchPick, boardOnly, effortOf, startEffort, checksOnly,
    };
    vm.runInNewContext(['var launchAvail = null;', piece('function boardPort('), piece('const promptHere ', ';\n'), piece('export function todoPromptText('),
      piece('export async function loadLaunchOptions('), piece('async function launchMode('), piece('function flashButton('),
      piece('export async function copyTodoPrompt('), piece('export async function copyBacklogPrompt('), piece('export async function openSessionInClaude(')].join('\n'), box);
    const btn = () => ({ innerHTML: '', title: '', textContent: '', classList: { toggle() {}, remove() {} } });
    if (listens) await box.loadLaunchOptions(); // the board asks it in advance, at its load
    await box.copyTodoPrompt([{ key: 'SIT-1' }], btn());
    await box.copyBacklogPrompt([{ key: 'SIT-2' }], btn());
    await box.openSessionInClaude({ session: '44444444-4444-4444-8444-444444444444', btn: btn() });
    const tail = port && port !== '3100' ? line(port) : '';
    if (listens) {
      const again = { ...box, api: async () => { throw new Error('offline'); } };
      vm.runInNewContext(['var launchAvail = null;', piece('export async function loadLaunchOptions(')].join('\n'), again);
      assert.deepEqual(Object.keys(await again.loadLaunchOptions()), []); // made in the vm's realm: compare the keys
      again.api = async () => ({ port: listens });
      assert.equal((await again.loadLaunchOptions()).port, listens, 'a failed ask of the port was kept: the page named its own port until a reload');
      // the copy buttons ask again by themselves: a copy after a failed ask names the board once the answer is in
      const copies = { ...box, copyText: async (t) => { copies.out.push(t); return true; }, out: [] };
      let up = false;
      copies.api = async () => { if (!up) throw new Error('offline'); return { port: listens }; };
      vm.runInNewContext(['var launchAvail = null;', piece('function boardPort('), piece('const promptHere ', ';\n'), piece('export function todoPromptText('),
        piece('export async function loadLaunchOptions('), piece('export async function copyTodoPrompt(')].join('\n'), copies);
      await copies.copyTodoPrompt([{ key: 'SIT-1' }], btn());
      up = true;
      await copies.copyTodoPrompt([{ key: 'SIT-1' }], btn()); // its own ask goes out now
      await new Promise((r) => { setImmediate(r); });
      await copies.copyTodoPrompt([{ key: 'SIT-1' }], btn());
      assert.ok(copies.out.at(-1).endsWith(line(port)) || port === '3100', `a copy never asked the port again: ${JSON.stringify(copies.out.at(-1))}`);
    }
    assert.ok(copied[0].startsWith('Run the kanban skill\n') && copied[0].endsWith(`SIT-1${tail}`), `${port || 'no port'}: the copy of To do — ${JSON.stringify(copied[0])}`);
    assert.ok(copied[1].endsWith(`SIT-2${tail}`), `${port || 'no port'}: the copy of Backlog — ${JSON.stringify(copied[1])}`);
    assert.equal(copied[2], `${tail ? `KB_URL=http://127.0.0.1:${port} ` : ''}claude --resume 44444444-4444-4444-8444-444444444444`, `${port || 'no port'}: the copied resume line`);
  }
});

// person's own level of any kind (code.claude.com/docs/en/model-config). The owner's "effortLevel": "high" did not reach
// Opus 5.5 (it ignores a top-level one of the user's settings) and the board's Claude ran at medium.
test('the effort level picked on the page goes to Claude inside the board and in the Terminal, and only a known one', async () => {
  for (const effort of launch.EFFORT_LEVELS) {
    const r = await post({ mode: 'board', text: 'Do it', project: 'site', effort });
    assert.equal(r.statusCode, 200, r.body);
    const args = r.json().args;
    const at = args.indexOf(`CLAUDE_CODE_EFFORT_LEVEL=${effort}`);
    assert.ok(at > 0 && args[at - 1] === '-e' && at < args.indexOf('--'), `inside the board: ${args.join(' ')}`);
    const t = await post({ mode: 'terminal', text: 'Do it', project: 'site', effort });
    assert.equal(t.statusCode, 200, t.body);
    assert.ok(t.json().args.join(' ').includes(`CLAUDE_CODE_EFFORT_LEVEL=${effort} claude `), t.json().args[1]);
  }
  // nothing picked: Claude Code decides by its own settings, the board sends no level
  assert.ok(!(await post({ mode: 'board', text: 'Do it', project: 'site' })).json().args.some((a) => /EFFORT/.test(a)));
  assert.ok(!(await post({ mode: 'terminal', text: 'Do it', project: 'site' })).json().args.join(' ').includes('EFFORT'));
  for (const mode of ['board', 'terminal']) {
    for (const effort of ['ultracode', 'HIGH', 'high; rm -rf ~', 7]) {
      const r = await post({ mode, text: 'Do it', project: 'site', effort });
      assert.equal(r.statusCode, 400, `${mode} took effort ${effort}`);
    }
  }
  // the Claude app takes no level from its link: a request with one is refused, not quietly cut
  assert.equal((await post({ mode: 'desktop', text: 'Do it', project: 'site', effort: 'high' })).statusCode, 400);
});

test('in a real shell the board\'s level wins over one the person\'s .zshrc exports, and theirs stays when none is picked', () => {
  const bin = mkdtempSync(join(tmpdir(), 'kb-bin-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "%s" "$CLAUDE_CODE_EFFORT_LEVEL"\n');
  chmodSync(join(bin, 'claude'), 0o755);
  try {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_EFFORT_LEVEL: 'low' };
    const run = (line) => execFileSync('/bin/sh', ['-c', line], { env }).toString();
    assert.equal(run(launch.terminalCommand({ text: 'x', folder, effort: 'max' })), 'max');
    assert.equal(run(launch.terminalCommand({ resume: '44444444-4444-4444-8444-444444444444', folder, effort: 'high' })), 'high');
    assert.equal(run(launch.terminalCommand({ text: 'x', folder })), 'low');
    assert.equal(run(launch.terminalCommand({ text: 'x', folder, effort: '$(echo hacked)' })), 'low', 'an unknown level reached the shell');
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('the page sends the level it holds: inside the board and to the Terminal, never to the Claude app', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(sse, /const effort = startEffort\(check \?\? checksOnly\(keys, state\.tasks\), getSetting\('effort'\), getSetting\('effortCheck'\)\);/);
  assert.match(sse, /permission: getSetting\('permission'\), effort \}/);
  assert.match(sse, /effort: mode === 'terminal' \? effort : undefined/);
  assert.match(settings.match(/const SETTINGS_DEFAULTS = \{([^\n]*)\};/)[1], /effort: ''/, 'a level is picked for the person by default');
  assert.match(settings, /buildSelect\(\$\('sel-effort'\)/);
});
