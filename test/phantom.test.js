// types answers into it and stops it. Pinned here against a real tmux on a private socket, with a stand-in
// for claude that logs where it runs, what it was given and every byte it reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { constants as osConstants, release, tmpdir, type as osType } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { screenCopy } from '../public/js/term-copy.js';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-test-${process.pid}`;
// the sign-in address /login prints is far longer than the 80 columns of the screen
const SIGN_IN = `https://claude.ai/oauth/authorize?code=true&client_id=${'9'.repeat(36)}&response_type=code&redirect_uri=${'x'.repeat(120)}&state=abc`;
let app, tmp, folder, plain, other, claudeDir, fakeLog, phantom, db;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  // a folder name tmux would read as a format (`#(...)` runs a command) and as a command separator:
  // expanded anywhere, it would not be the folder Claude starts in
  folder = join(realpathSync(mkdtempSync(join(tmpdir(), 'kb-phantom-'))), 'odd #S #{session_name} #(echo pwned) dir;');
  mkdirSync(folder);
  plain = realpathSync(mkdtempSync(join(tmpdir(), 'kb-plain-')));
  other = realpathSync(mkdtempSync(join(tmpdir(), 'kb-other-')));
  claudeDir = join(tmp, 'claude');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ projects: { [plain]: { hasTrustDialogAccepted: true } } }));
  fakeLog = join(tmp, 'fake.log');
  mkdirSync(join(tmp, 'bin'));
  const fake = join(tmp, 'bin', 'claude');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(o) + '\\n');
log({ cwd: process.cwd(), argv: process.argv.slice(2), claudecode: process.env.CLAUDECODE ?? null,
  sid: process.env.CLAUDE_CODE_SESSION_ID ?? null, kb: process.env.KB_URL ?? null, port: process.env.PORT ?? null,
  pm2: process.env.pm_id ?? null, path: process.env.PATH ?? null, lang: process.env.LANG ?? null, pid: process.pid, ppid: process.ppid,
  suggest: process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION ?? null, alt: process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN ?? null,
  simple: process.env.CLAUDE_CODE_SIMPLE ?? null });
process.on('exit', (code) => log({ exit: code, pid: process.pid }));
process.stdout.write('fake claude ready \\u2713 \\u65e5\\u672c\\n');
process.stdout.write('Use the url below to sign in: (' + ${JSON.stringify(SIGN_IN)} + ').\\n\\x1b[?2004h');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8'); // a letter split between two reads stays whole
process.stdin.on('data', (s) => {
  log({ got: s }); if (s.includes('\\x03')) process.exit(3);
  // a question the way Claude Code asks one, its footer wrapped by a narrow window — and the prompt after it
  if (s.includes('ASK')) process.stdout.write('\\r\\nWhich color?\\r\\n\\u276f 1. Orange\\r\\n  2. Blue\\r\\nEnter to select \\u00b7 \\u2191/\\u2193 to navigate \\u00b7 Esc to\\r\\ncancel\\r\\n');
  if (s.includes('ANSWERED')) process.stdout.write('\\r\\n> \\r\\n\\u2500\\u2500\\u2500\\r\\n  ? for shortcuts\\r\\n');
  // acceptance CK-607: the input box with Claude Code's stop at the usage limit under it (CK-590), and a long output (CK-594)
  if (s.includes('LIMIT')) process.stdout.write('\\r\\n' + '\\u2500'.repeat(30) + '\\r\\n\\u276f \\r\\n' + '\\u2500'.repeat(30) + '\\r\\n  \\u26a0 Usage limit reached \\u00b7 limit resets\\r\\n  12:50am \\u00b7 /usage-credits\\r\\n  \\u23f5\\u23f5 auto mode on \\u00b7 1 shell\\r\\n');
  // CK-602: the input box again, with nothing running under it
  if (s.includes('QUIET')) process.stdout.write('\\r\\n' + '\\u2500'.repeat(30) + '\\r\\n\\u276f \\r\\n' + '\\u2500'.repeat(30) + '\\r\\n  ? for shortcuts\\r\\n');
  if (s.includes('MANY')) for (let i = 0; i < 1100; i++) process.stdout.write('row ' + String(i).padStart(4, '0') + '\\r\\n');
});
process.stdout.on('resize', () => log({ resized: process.stdout.columns }));
`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, {
    KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET, KB_CLAUDE_BIN: fake, KB_CLAUDE_DIR: claudeDir,
    // as if the board ran under pm2 and had been started from inside a Claude session, as both boards of the owner are
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '99999999-9999-4999-8999-999999999999', pm_id: '7', PORT: '3100',
  });
  delete process.env.KB_LAUNCH_DRYRUN;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  phantom = await import('../src/phantom.js');
  // the stand-in's start looks at the terminal (launchOn → alive): a look would keep every terminal from resting — the
  phantom.setLookHold(0);
  const add = db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?,?,?,?,?)');
  add.run('odd', 'ODD', 'Odd', 3, folder);
  add.run('plain', 'PLN', 'Plain', 2, plain);
  add.run('nofolder', 'NOF', 'No folder', 2, null);
  add.run('other', 'OTH', 'Other', 2, other);
  add.run('lost', 'LST', 'Lost', 2, '/nowhere/at/all');
  for (const [slug, n] of [['odd', 1], ['odd', 2], ['plain', 1], ['nofolder', 1], ['other', 1], ['lost', 1]]) {
    const pid = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
    db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pid, n);
  }
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (TMUX) { try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server left */ } }
  // tmux leaves the socket file behind; one per run would pile up
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  for (const k of ['KB_TMUX_SOCKET', 'KB_CLAUDE_BIN', 'KB_CLAUDE_DIR', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'pm_id', 'PORT']) delete process.env[k];
  for (const d of [tmp, folder && join(folder, '..'), plain, other]) if (d) rmSync(d, { recursive: true, force: true });
});

const entries = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// eight copies of this file side by side (load ~20); a wait that comes true returns at once all the same
async function until(check, what, ms = 15000, seen = () => undefined) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}${seen() === undefined ? '' : `; last seen: ${JSON.stringify(seen())}`}`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}
const inject = (method, url, payload) => app.inject({ method, url, payload });
// A stand-in tmux first on the PATH, for the tests that count the calls: it writes each one down and runs the
// `slow-1`, `slow-2`… hold how many seconds the next looks over the whole socket (a sweep's) wait first, one file
// finds tmux on the PATH at every call
const standIn = () => {
  const dir = join(tmp, 'stand-in');
  if (!existsSync(dir)) {
    mkdirSync(dir);
    const once = join(dir, 'fail-once');
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(dir, 'calls.log')}'
case "$*" in
  *new-session*) if [ -f '${once}' ]; then cat '${once}' >&2; rm -f '${once}'; exit 1; fi;;
  *"list-panes -a"*) for i in 1 2 3 4 5 6 7 8 9; do
      if mv '${dir}/slow-'$i '${dir}/taken-'$$ 2>/dev/null; then sleep "$(cat '${dir}/taken-'$$)"; rm -f '${dir}/taken-'$$; break; fi
    done
    if [ -f '${dir}/lost-time' ]; then '${TMUX}' "$@" | sed 's/|[0-9]*$/|/'; exit; fi;;
esac
exec '${TMUX}' "$@"
`);
    chmodSync(join(dir, 'tmux'), 0o755);
  }
  return dir;
};
const slowSweeps = (...seconds) => seconds.forEach((sec, i) => writeFileSync(join(standIn(), `slow-${i + 1}`), String(sec)));
const standInCalls = () => { const f = join(standIn(), 'calls.log'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []; };
async function viaStandIn(fn) {
  const path = process.env.PATH;
  process.env.PATH = `${standIn()}:${path}`;
  try { return await fn(); } finally { process.env.PATH = path; }
}
const NASTY = `Run the kanban skill\nDo the task ODD-1 #{session_name} #(touch /tmp/kb-pwned) \`id\` $(id) 'q' "dq" \\ ;`;

const ruleMatches = (rule, cmd) => {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const re = m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/ \.\*$/, '( .*)?');
  return new RegExp(`^${re}$`).test(cmd);
};
test('Claude inside the board moves a task through the working columns without asking and closes none', () => {
  assert.ok(ruleMatches('Bash(git log * main)', 'git log --oneline main') && ruleMatches('Bash(npm run *)', 'npm run'), 'the matcher is not the one of the docs');
  const free = (cmd) => phantom.BOARD_ALLOWED.some((r) => ruleMatches(r, cmd));
  for (const st of ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review']) assert.ok(free(`kb mv CK-12 ${st}`), `kb mv CK-12 ${st} asks`);
  for (const st of ['done', 'dn', 'cancelled', 'cancel', 'c']) assert.ok(!free(`kb mv CK-12 ${st}`), `kb mv CK-12 ${st} went without asking`);
  for (const cmd of ['kb done CK-12', 'kb cancel CK-12', 'kb rm CK-12']) assert.ok(!free(cmd), `${cmd} went without asking`);
  for (const cmd of ['kb ls', 'kb take demo', 'kb review CK-12 "a note"']) assert.ok(free(cmd), `${cmd} asks`);
});

test('a tmux argument ending in ";" is read back whole, and only the separators split commands', () => {
  assert.equal(phantom.tmuxArg('do it;'), 'do it\\;');
  assert.equal(phantom.tmuxArg('a\\;'), 'a\\\\;');
  assert.equal(phantom.tmuxArg(';'), '\\;');
  assert.equal(phantom.tmuxArg('plain'), 'plain');
  const argv = phantom.tmuxArgv([['a', 'b;'], ['c']]);
  assert.deepEqual(argv.slice(2), ['a', 'b\\;', ';', 'c']);
});

test('the new Claude gets the environment of a terminal, not of the board process', () => {
  // the board under pm2, started from a Claude session: the names are the ones pm2 env showed on 02.10.2026
  const board = {
    PATH: '/bin', HOME: '/h', USER: 'u', SHELL: '/bin/zsh', TMPDIR: '/t', SSH_AUTH_SOCK: '/a', LANG: 'en_US.UTF-8', https_proxy: 'p',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', AI_AGENT: 'a', CLAUDE_EFFORT: 'h',
    BAGGAGE: 'b', GIT_EDITOR: 'true', USE_STAGING_OAUTH: '1', API_TIMEOUT_MS: '1', __CFBundleIdentifier: 'c',
    PORT: '3100', pm_id: '1', PM2_HOME: '/p', NODE_APP_INSTANCE: '0', namespace: 'default', unique_id: 'x', NODE_ENV: 'production',
    KB_DATA_DIR: '/d', TMUX: '/s', TMUX_PANE: '%1',
  };
  assert.deepEqual(phantom.cleanEnv(board), { PATH: '/bin', HOME: '/h', USER: 'u', SHELL: '/bin/zsh', TMPDIR: '/t', SSH_AUTH_SOCK: '/a', LANG: 'en_US.UTF-8', https_proxy: 'p' });
  // started from a plain shell, the person's own settings for Claude are theirs and pass through
  assert.deepEqual(phantom.cleanEnv({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k', PORT: '3100', pm_id: '1' }),
    { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k', LANG: phantom.DEFAULT_LANG });
  assert.deepEqual(phantom.cleanEnv({ PATH: '/bin', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_USE_BEDROCK: '1' }),
    { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', LANG: phantom.DEFAULT_LANG });
  // wc -m counted bytes. The person's own language stays theirs
  assert.match(phantom.DEFAULT_LANG, /\.UTF-8$/);
  assert.equal(phantom.cleanEnv({ PATH: '/bin', LANG: '' }).LANG, phantom.DEFAULT_LANG);
  assert.equal(phantom.cleanEnv({ PATH: '/bin', LANG: 'ru_RU.UTF-8', LC_CTYPE: 'UTF-8' }).LANG, 'ru_RU.UTF-8');
});

test('a folder is trusted when Claude Code has trusted it or a folder above it', () => {
  assert.equal(phantom.folderTrusted(plain), true);
  assert.equal(phantom.folderTrusted(join(plain, 'sub', 'deeper')), true);
  assert.equal(phantom.folderTrusted(other), false);
});

test('a request to start inside the board is checked before anything runs', async () => {
  const post = (b) => inject('POST', '/api/launch', { mode: 'board', text: 'Do ODD-1', project: 'odd', keys: ['ODD-1'], ...b });
  const no = async (b, code, re) => { const r = await post(b); assert.equal(r.statusCode, code, r.body); assert.match(r.json().error, re); return r.json(); };
  await no({ permission: 'bypassPermissions' }, 400, /permission/);
  await no({ resume: '44444444-4444-4444-8444-444444444444' }, 400, /board/);
  await no({ host: 'local_ab' }, 400, /board/);
  await no({ keys: ['ODD-1; rm -rf /'] }, 400, /keys/);
  await no({ keys: [] }, 400, /keys/);
  await no({ text: '' }, 400, /text/);
  await no({ text: 'a\0b' }, 400, /NUL/);
  await no({ keys: ['ODD-404'] }, 404, /task/);
  await no({ keys: ['OTH-1'] }, 400, /this project/);
  await no({ project: 'nope' }, 404, /project/);
  const noProject = await no({ project: undefined }, 400, /project folder/);
  assert.equal(noProject.fallback, true, 'the setting "auto" tries the next way');
  assert.equal(noProject.reason, 'no-project', 'the page explains it in its own words');
  // no folder: the page offers to make one, so the answer says which project and what folder it would be
  const noFolder = await no({ project: 'nofolder', keys: ['NOF-1'] }, 409, /no folder/);
  assert.deepEqual({ ...noFolder, error: undefined }, { error: undefined, fallback: true, reason: 'no-folder', project: 'nofolder', name: 'No folder', missing: null, suggest: join(tmp, 'projects', 'nofolder') });
  assert.equal((await no({ project: 'lost', keys: ['LST-1'] }, 409, /no folder/)).missing, '/nowhere/at/all');
  assert.equal(entries().length, 0, 'a refused request started something');
  const options = (await inject('GET', '/api/launch')).json();
  assert.equal(options.board, Boolean(TMUX));
});

test('a project without a folder gets a new one in a click, and never a folder that is already there', async () => {
  // a folder with the project's name is there already — someone's code, say: it is left alone
  mkdirSync(join(tmp, 'projects', 'nofolder'), { recursive: true });
  writeFileSync(join(tmp, 'projects', 'nofolder', 'keep.txt'), 'theirs');
  const r = await inject('POST', '/api/projects/nofolder/folder');
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().path, join(tmp, 'projects', 'nofolder-2'));
  assert.ok(existsSync(join(tmp, 'projects', 'nofolder-2')));
  assert.equal(readFileSync(join(tmp, 'projects', 'nofolder', 'keep.txt'), 'utf8'), 'theirs');
  assert.equal((await inject('POST', '/api/projects/nofolder/folder')).statusCode, 409, 'a project with its folder got another one');
  // a project whose folder is gone from this computer gets a new one in place of it
  assert.equal((await inject('POST', '/api/projects/lost/folder')).json().path, join(tmp, 'projects', 'lost'));
  assert.equal((await inject('POST', '/api/projects/nope/folder')).statusCode, 404);
});

test('once the project has its folder, ▶ starts at once', { skip }, async () => {
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do NOF-1', project: 'nofolder', keys: ['NOF-1'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().folder, join(tmp, 'projects', 'nofolder-2'));
  await until(() => entries().some((e) => e.argv?.includes(r.json().session)), 'the start');
  assert.equal((await inject('DELETE', '/api/tasks/NOF-1/terminal')).statusCode, 200);
});

let sid;
test('▶ starts Claude in the background at once: the prompt, the folder and the session are exactly the board\'s', { skip }, async () => {
  const { bus } = await import('../src/bus.js');
  let on;
  const starting = new Promise((resolve) => {
    on = (e) => { if (e.type === 'task.live' && e.data.tasks.some((x) => x.key === 'ODD-1' && x.claude === 'starting')) resolve(); };
    bus.on('event', on);
  });
  const r = await inject('POST', '/api/launch', { mode: 'board', text: NASTY, project: 'odd', keys: ['ODD-1', 'ODD-2'], permission: 'acceptEdits' });
  assert.equal(r.statusCode, 200, r.body);
  await until(() => Promise.race([starting.then(() => true), new Promise((d) => { setTimeout(() => d(false), 50); })]), 'task.live saying ODD-1 is starting');
  bus.off('event', on);
  const j = r.json();
  sid = j.session;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(j.folder, folder);
  assert.equal(j.trusted, false);
  const start = await until(() => entries().find((e) => e.argv?.includes(sid)), 'the stand-in to start');
  assert.equal(start.cwd, folder, 'Claude started somewhere else');
  // command line was what `pkill -f "kb hook permission"` matched in every Claude of the board
  const hooked = start.argv[0] === '--settings';
  if (hooked) assert.equal(JSON.parse(readFileSync(start.argv[1], 'utf8')).hooks.PermissionRequest[0].matcher, 'AskUserQuestion');
  assert.ok(!start.argv.join(' ').includes('kb hook permission'), 'the hook\'s text is on the command line of Claude again');
  assert.deepEqual(start.argv.slice(hooked ? 2 : 0), ['--allowedTools', ...phantom.BOARD_ALLOWED, '--permission-mode', 'acceptEdits', '--name', 'ODD-1 +1', '--session-id', sid, NASTY]);
  // the board's bookkeeping goes without asking; the person's word (done, cancel, rm) does not
  assert.ok(phantom.BOARD_ALLOWED.includes('Bash(kb review *)') && phantom.BOARD_ALLOWED.includes('Bash(kb ls)'));
  assert.ok(!phantom.BOARD_ALLOWED.some((r) => /^Bash\(kb (done|cancel|rm)\b/.test(r)), 'done, cancel or rm went without asking');
  assert.equal(start.claudecode, null, 'Claude was told it runs inside another Claude session');
  assert.equal(start.sid, null);
  assert.equal(start.port, null, "the board's PORT reached Claude: a server it starts would take the board's port");
  assert.equal(start.pm2, null);
  assert.equal(start.path, `${phantom.KB_BIN_DIR}:${process.env.PATH}`, "Claude did not get the board's PATH with the board's own kb first");
  assert.equal(realpathSync(join(start.path.split(':')[0], 'kb')), realpathSync(new URL('../bin/kb', import.meta.url)), 'kb first on the PATH is not this board\'s');
  assert.equal(start.kb, 'http://127.0.0.1:3100');
  assert.equal(start.lang, process.env.LANG || phantom.DEFAULT_LANG, 'Claude started without a UTF-8 language');
  assert.equal(start.suggest, 'false', 'Claude of the board started with its prompt suggestions on');
  assert.equal(start.alt, '1', 'Claude of the board started on the alternate screen, which keeps no history');
  assert.ok(!existsSync('/tmp/kb-pwned'), 'a format or a shell ran a command from the prompt');
  assert.deepEqual(j.prep, ['ODD-1', 'ODD-2']);
  for (const key of ['ODD-1', 'ODD-2']) {
    const t = (await inject('GET', `/api/tasks/${key}`)).json();
    assert.equal(t.terminal?.session, sid, key);
    assert.equal(t.terminal.dead, false);
    assert.equal(t.status, 'prep', `${key} waits in To do for its Claude to come up`);
    assert.deepEqual(db.prepare("SELECT e.session_id, l.via FROM task_events e LEFT JOIN task_launches l ON l.event_id = e.id WHERE e.task_id = ? AND e.status = 'prep'").all(t.id),
      [{ session_id: sid, via: 'board' }], `${key}: the move is not the started session's, or not marked as ▶'s`);
  }
  // that Claude takes them (`kb mv <key> prep`, as the skill says); another session is refused
  const as = (who, key) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': who }, payload: { status: 'prep' } });
  assert.equal((await as(sid, 'ODD-1')).statusCode, 200, 'the Claude the board started was refused its own task');
  assert.equal((await as('77777777-7777-4777-8777-777777777777', 'ODD-1')).statusCode, 409, 'another session took the task');
  assert.equal((await inject('GET', '/api/tasks/PLN-1')).json().terminal, null);
});

test('the language goes with the session, whoever started the tmux server of the socket', { skip }, async () => {
  // one may have started it without a language — the board's own goes with `-e`. The server runs now (ODD-1
  // above is alive) with another LANG than the one set here, so only `-e` can bring this one
  const was = process.env.LANG;
  process.env.LANG = 'ru_RU.UTF-8';
  let r;
  try { r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do PLN-1', project: 'plain', keys: ['PLN-1'] }); } finally {
    if (was === undefined) delete process.env.LANG; else process.env.LANG = was;
  }
  try {
    assert.equal(r.statusCode, 200, r.body);
    const start = await until(() => entries().find((e) => e.argv?.includes(r.json().session)), 'the start');
    assert.equal(start.lang, 'ru_RU.UTF-8', "the language of the tmux server's starter reached Claude, not the board's");
  } finally {
    await inject('DELETE', '/api/tasks/PLN-1/terminal'); // the tests after it start their own Claude on PLN-1
  }
});

// pane takes the server's global environment, and cleanEnv only cleans the client's. The server of the socket runs now
// (ODD-1 above is alive); it is given the variable as such a shell would have
test('the bare mode does not reach Claude through a tmux server that has it', { skip }, async () => {
  execFileSync(TMUX, ['-L', SOCKET, 'set-environment', '-g', 'CLAUDE_CODE_SIMPLE', '1']);
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do PLN-1', project: 'plain', keys: ['PLN-1'] });
  try {
    assert.equal(r.statusCode, 200, r.body);
    const start = await until(() => entries().find((e) => e.argv?.includes(r.json().session)), 'the start');
    assert.equal(start.simple, null, 'the tmux server passed the bare mode on to the Claude of the board');
  } finally {
    await inject('DELETE', '/api/tasks/PLN-1/terminal');
    try { execFileSync(TMUX, ['-L', SOCKET, 'set-environment', '-g', '-u', 'CLAUDE_CODE_SIMPLE']); } catch { /* gone */ }
  }
});

test('▶ takes the longest prompt tmux takes and refuses a longer one before anything runs', { skip }, async () => {
  // failed with 500 «command too long» at ~7 640 letters while 14 336 were promised. The limit is in bytes now
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('long', 'LNG', 'Long', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  // all the start takes besides the prompt: the session id is random, its length is not
  const base = phantom.tmuxCommandBytes(phantom.phantomSpec({ sid: '00000000-0000-4000-8000-000000000000', name: 'LNG-1', text: '', folder: plain, permission: 'auto', port: 3100 }).args);
  const room = phantom.TMUX_COMMAND_MAX - base; // bytes left for the prompt
  const fits = `${'я'.repeat(Math.floor(room / 2) - 1)}${'x'.repeat(room % 2 + 2)}`;
  assert.equal(Buffer.byteLength(fits), room);
  assert.ok(fits.length < 8200 && room > 14000, `a Cyrillic prompt of ${fits.length} letters`);
  const starts = entries().filter((e) => e.argv).length;
  const over = await inject('POST', '/api/launch', { mode: 'board', text: `${fits}x`, project: 'long', keys: ['LNG-1'] });
  assert.equal(over.statusCode, 400, over.body);
  assert.deepEqual([over.json().reason, over.json().fallback], ['too-long', true], 'the setting "auto" cannot take it to the app or the Terminal');
  const r = await inject('POST', '/api/launch', { mode: 'board', text: fits, project: 'long', keys: ['LNG-1'] });
  assert.equal(r.statusCode, 200, r.body);
  const start = await until(() => entries().find((e) => e.argv?.includes(r.json().session)), 'the start');
  assert.equal(start.argv.at(-1), fits, 'the prompt reached Claude cut or changed');
  assert.equal(entries().filter((e) => e.argv).length, starts + 1, 'the refused prompt started something');
  assert.equal((await inject('DELETE', '/api/tasks/LNG-1/terminal')).statusCode, 200);
});

test('a second ▶ on a task the board\'s Claude already works on opens that one instead of starting another', { skip }, async () => {
  const starts = entries().filter((e) => e.argv).length;
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do ODD-2 again', project: 'odd', keys: ['ODD-2'] });
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json().running, ['ODD-2']);
  await new Promise((done) => { setTimeout(done, 300); });
  assert.equal(entries().filter((e) => e.argv).length, starts, 'a second Claude started on the same task');
});

test('two ▶ at once (a double click) start one Claude, not two', { skip }, async () => {
  const starts = entries().filter((e) => e.argv).length;
  const body = { mode: 'board', text: 'Do PLN-1', project: 'plain', keys: ['PLN-1'] };
  const [a, b] = await Promise.all([inject('POST', '/api/launch', body), inject('POST', '/api/launch', body)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} ${b.body}`);
  await until(() => entries().filter((e) => e.argv).length > starts, 'the start');
  await new Promise((done) => { setTimeout(done, 300); });
  assert.equal(entries().filter((e) => e.argv).length, starts + 1, 'two Claudes started on one task');
  assert.equal((await inject('DELETE', '/api/tasks/PLN-1/terminal')).statusCode, 200);
});

// the board stood in the server's argv, and a `pkill -f` on `--permission-mode` or a task's key took every terminal of
// the board with it. The server of the socket runs now — the first ▶ of this file started it
test('the tmux server of the board carries nothing of a task in its command line, and still leaves with its last session', { skip }, async () => {
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do PLN-1', project: 'plain', keys: ['PLN-1'] });
  try {
    assert.equal(r.statusCode, 200, r.body);
    const pid = execFileSync(TMUX, ['-L', SOCKET, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
    const argv = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
    for (const word of ['claude', '--permission-mode', 'Bash(kb', 'PLN-1', 'ODD-1', '--name', 'new-session']) {
      assert.ok(!argv.includes(word), `the tmux server's command line has «${word}»: ${argv}`);
    }
    // held up only while it starts: a socket whose sessions are gone has no server left on it
    assert.equal(execFileSync(TMUX, ['-L', SOCKET, 'show-options', '-s', 'exit-empty'], { encoding: 'utf8' }).trim(), 'exit-empty on');
  } finally {
    await inject('DELETE', '/api/tasks/PLN-1/terminal');
  }
});
test('▶ that reaches a tmux server on its way out tries once more and starts; no other refusal is tried again', { skip }, async () => {
  // «server exited unexpectedly» — a 500 instead of Claude, and in this file a cascade of six red tests. That
  // server has made nothing, so a second try is safe: it starts a new one
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('race', 'RCE', 'Race', 3, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const starts = () => standInCalls().filter((c) => c.includes('new-session')).length;
  let was = starts();
  writeFileSync(join(standIn(), 'fail-once'), 'server exited unexpectedly');
  const r = await viaStandIn(() => inject('POST', '/api/launch', { mode: 'board', text: 'Do RCE-1', project: 'race', keys: ['RCE-1'] }));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(starts() - was, 2, 'the start was not tried again');
  await until(() => entries().some((e) => e.argv?.includes(r.json().session)), 'the start on the second try');
  was = starts();
  writeFileSync(join(standIn(), 'fail-once'), 'duplicate session: kb-x');
  const no = await viaStandIn(() => inject('POST', '/api/launch', { mode: 'board', text: 'Do RCE-2', project: 'race', keys: ['RCE-2'] }));
  assert.equal(no.statusCode, 500, no.body);
  assert.match(no.json().error, /duplicate session/);
  assert.equal(starts() - was, 1, 'a refusal a second try cannot cure was tried again');
  assert.deepEqual([(await inject('GET', '/api/tasks/RCE-1')).json().status, (await inject('GET', '/api/tasks/RCE-2')).json().status], ['prep', 'todo']);
  assert.equal((await inject('DELETE', '/api/tasks/RCE-1/terminal')).statusCode, 200);
});

test('the card shows the screen of the session, with the text as it is', { skip }, async () => {
  const term = await until(async () => {
    const t = (await inject('GET', '/api/tasks/ODD-1/terminal')).json();
    return t.screen.includes('ready') && t;
  }, 'the screen');
  assert.equal(term.session, sid);
  assert.match(term.screen, /fake claude ready ✓ 日本/);
  // the screen wraps the long address over rows; the card gets it whole, without the punctuation after it
  assert.ok(!term.screen.includes(SIGN_IN), 'the screen is not row by row');
  assert.deepEqual(term.links, [SIGN_IN]);
  assert.ok(term.wraps.length > 0, 'no row of the screen is named as wrapped');
  assert.ok(screenCopy(term.screen, term, 0, term.screen.length).includes(SIGN_IN), 'a copy of the screen breaks the address');
  assert.deepEqual((await inject('GET', '/api/tasks/PLN-1/terminal')).json(), { session: null });
});

test('a look at a screen that has not changed is a short answer, and any look is one call to tmux', { skip }, async () => {
  // screen joined for its links) and sent the whole screen again, 19–29 KB, 9 times out of 9 the same
  const look = async (q = '') => (await inject('GET', `/api/tasks/ODD-1/terminal${q}`)).json();
  const full = await until(async () => { const a = await look(); const b = await look(); return a.v === b.v && a; }, 'a screen at rest');
  assert.match(full.v, /^[0-9a-f]{20}$/);
  assert.equal(full.session, sid);
  assert.deepEqual(await look(`?seen=${full.v}`), { same: true, v: full.v }, 'the screen the card has came again');
  assert.equal((await look('?seen=0123456789abcdef0123')).screen, full.screen, 'another answer was taken for the one the card has');
  assert.equal((await inject('GET', `/api/tasks/ODD-1/terminal?seen=a&seen=b`)).statusCode, 400);
  const calls = standInCalls().length;
  const again = await viaStandIn(() => look(`?seen=${full.v}`));
  assert.equal(again.same, true);
  const made = standInCalls().slice(calls);
  assert.equal(made.filter((c) => c.includes(`kb-${sid}`)).length, 1, `one look took these calls to tmux: ${JSON.stringify(made)}`);
  // the screen changes: all of it comes again, with its new mark
  await inject('POST', '/api/tasks/ODD-1/terminal', { text: 'ANSWERED' });
  const changed = await until(async () => { const r = await look(`?seen=${full.v}`); return !r.same && r; }, 'the changed screen');
  assert.notEqual(changed.v, full.v);
  assert.match(changed.screen, /\? for shortcuts$/);
  assert.deepEqual(changed.links, full.links);
});

test('an answer is typed as it is, an Enter goes apart from it, and several lines go in as one paste', { skip }, async () => {
  const send = (b) => inject('POST', '/api/tasks/ODD-2/terminal', b);
  const from = entries().length;
  assert.equal((await send({ text: 'yes; #{session_name} `id`;', key: 'Enter' })).statusCode, 200);
  await until(() => entries().slice(from).some((e) => e.got === '\r'), 'the Enter');
  assert.deepEqual(entries().slice(from).filter((e) => e.got !== undefined).map((e) => e.got), ['yes; #{session_name} `id`;', '\r'], 'the text and the Enter came in one read');
  const at = entries().length;
  assert.equal((await send({ text: 'line one\r\nline two;', key: 'Enter' })).statusCode, 200);
  await until(() => entries().slice(at).some((e) => e.got === '\r'), 'the Enter after the paste');
  assert.deepEqual(entries().slice(at).filter((e) => e.got !== undefined).map((e) => e.got), ['\x1b[200~line one\nline two;\x1b[201~', '\r']);
  const got = () => entries().filter((e) => e.got !== undefined);
  const k = got().length;
  assert.equal((await send({ key: 'Down' })).statusCode, 200);
  await until(() => got().length > k, 'the key');
  assert.equal(got().at(-1).got, '\x1b[B');
  assert.equal((await send({ key: 'C-x' })).statusCode, 400, 'a key outside the list');
  assert.equal((await send({ text: 'x'.repeat(phantom.REPLY_MAX + 1) })).statusCode, 400);
  assert.equal((await send({})).statusCode, 400);
  assert.equal((await inject('POST', '/api/tasks/PLN-1/terminal', { text: 'x' })).statusCode, 404);
});

// Code takes as the picture — each before the words, and the Enter last
test('pictures of a chat go in as pastes of their own paths, before the words and the Enter', { skip }, async () => {
  const got = () => entries().filter((e) => e.got !== undefined).map((e) => e.got);
  const from = got().length;
  const r = await phantom.phantomSend(sid, { text: 'what is on these', key: 'Enter', paste: true, images: ['/d/a 1.png', '/d/b.png'] });
  assert.equal(r.err, null);
  await until(() => got().slice(from).includes('\r'), 'the Enter after the pictures');
  assert.deepEqual(got().slice(from), ['\x1b[200~/d/a 1.png\x1b[201~', '\x1b[200~/d/b.png\x1b[201~', '\x1b[200~what is on these\x1b[201~', '\r'],
    'a picture went inside the words, or after the Enter');
});

test('a reply or a message as long as the card allows reaches Claude whole, in any alphabet', { skip }, async () => {
  // failed with 500 «command too long» at ~8 150 letters, a message to Claude at ~8 090. It goes in by stdin now
  const typed = (from) => entries().slice(from).filter((e) => e.got !== undefined).map((e) => e.got).join('');
  const got = async (from, want, what) => {
    await until(() => typed(from).length >= want.length, what, undefined, () => typed(from).length);
    await pause(200); // anything after it would be a fault too
    assert.equal(typed(from), want, `${what} came in cut or changed`);
  };
  let from = entries().length;
  const one = 'я'.repeat(phantom.REPLY_MAX);
  assert.equal((await inject('POST', '/api/tasks/ODD-2/terminal', { text: one })).statusCode, 200);
  await got(from, one, 'a long reply in one line');
  const lines = `${'ж'.repeat(100)}\n${'ш'.repeat(phantom.REPLY_MAX - 101)}`;
  from = entries().length;
  assert.equal((await inject('POST', '/api/tasks/ODD-2/terminal', { text: lines, key: 'Enter' })).statusCode, 200);
  await got(from, `\x1b[200~${lines}\x1b[201~\r`, 'a long reply of several lines and its Enter');
  const msg = 'щ'.repeat(phantom.REPLY_MAX);
  from = entries().length;
  const said = await inject('POST', '/api/tasks/ODD-2/terminal/message', { text: msg });
  assert.equal(said.statusCode, 200, said.body);
  await got(from, `\x1b[200~ODD-2: ${msg}\x1b[201~\r`, 'a long message to Claude and its Enter');
});

test('a reply is text: a key name in it is typed, not pressed, and NUL is refused before anything is typed', { skip }, async () => {
  // answer; NUL reached the command line of tmux and came back as a 500
  const typed = (from) => entries().slice(from).filter((e) => e.got !== undefined).map((e) => e.got).join('');
  let from = entries().length;
  for (const text of ['C-c', 'Enter', 'Escape']) assert.equal((await inject('POST', '/api/tasks/ODD-2/terminal', { text })).statusCode, 200);
  await until(() => typed(from).endsWith('Escape'), 'the key names as text', undefined, () => typed(from));
  assert.equal(typed(from), 'C-cEnterEscape');
  assert.equal((await inject('GET', '/api/tasks/ODD-2/terminal')).json().dead, false, 'a reply «C-c» stopped Claude');
  from = entries().length;
  for (const text of ['a\0b', '\0']) {
    const r = await inject('POST', '/api/tasks/ODD-2/terminal', { text, key: 'Enter' });
    assert.equal(r.statusCode, 400, `${JSON.stringify(text)}: ${r.body}`);
  }
  await pause(300);
  assert.equal(typed(from), '', 'a refused reply typed something');
});

async function exitDiagnosis(t, sid) {
  const say = async (what, f) => {
    let v;
    try { v = await f(); } catch (e) { v = `n/a (${String(e.message).split('\n')[0]})`; }
    t.diagnostic(`CK-466 ${what}: ${v}`);
  };
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); } catch (e) { if (e.status === 1) return ''; throw e; } };
  const tm = (...args) => sh(TMUX, ['-L', SOCKET, ...args]);
  const pane = `=kb-${sid}:`;
  const fields = 'dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal}';
  const start = entries().find((e) => e.argv?.includes(sid)) || {};
  const ended = entries().find((e) => e.exit !== undefined && e.pid === start.pid);
  const panePid = Number(tm('list-panes', '-t', pane, '-F', '#{pane_pid}'));
  const serverPid = Number(tm('display-message', '-p', '-t', pane, '#{pid}'));
  await say('tmux', () => `${sh(TMUX, ['-V'])} (${TMUX}) on ${osType()} ${release()}`);
  await say('the pane', () => tm('list-panes', '-t', pane, '-F', `pid=#{pane_pid} ${fields} at=#{pane_dead_time} cmd=#{pane_current_command}`));
  await say('the stand-in', () => `pid ${start.pid}, parent ${start.ppid}; the pane's pid ${panePid === start.pid ? 'is it' : `is ${panePid}, NOT it`}; `
    + `the tmux server ${serverPid} ${start.ppid === serverPid ? 'is its parent' : 'is NOT its parent'}; ${ended ? `it exited with ${ended.exit}` : 'no exit written down'}`);
  await say('the pane process now (Z = a zombie nobody reaped)', () => sh('ps', ['-o', 'pid=,ppid=,stat=,comm=', '-p', String(panePid)]) || 'gone — reaped');
  await say('children of the pane process and of the tmux server', () => sh('ps', ['-A', '-o', 'pid=,ppid=,stat=,comm='])
    .split('\n').filter((l) => [panePid, serverPid].includes(Number(l.trim().split(/\s+/)[1]))).map((l) => l.trim()).join(' | ') || 'none');
  await say('SIGCHLD in the tmux server', () => {
    const st = readFileSync(`/proc/${serverPid}/status`, 'utf8');
    const bit = (k) => (BigInt(`0x${new RegExp(`^${k}:\\s*([0-9a-f]+)`, 'm').exec(st)[1]}`) >> BigInt(osConstants.signals.SIGCHLD - 1)) & 1n;
    return `blocked ${bit('SigBlk')}, ignored ${bit('SigIgn')}, caught ${bit('SigCgt')}`;
  });
  await say('the pane process in /proc', () => {
    const st = readFileSync(`/proc/${panePid}/status`, 'utf8');
    return ['State', 'PPid'].map((k) => `${k} ${new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(st)?.[1]}`).join(', ');
  });
  await say('libutempter in this tmux', () => sh('ldd', [TMUX]).split('\n').find((l) => /utempter/.test(l))?.trim() || 'not linked');
  // the experiment: a lost SIGCHLD is one signal away from the code — tmux reaps every exited child it has on
  // the next SIGCHLD it handles. The code coming now means tmux simply never heard of the exit
  await say('after one more SIGCHLD to the tmux server', async () => {
    process.kill(serverPid, 'SIGCHLD');
    await new Promise((r) => { setTimeout(r, 500); });
    return tm('list-panes', '-t', pane, '-F', fields);
  });
}

test('when Claude exits the card keeps its last screen and the exit code; closing it removes the session', { skip }, async (t) => {
  assert.equal((await inject('POST', '/api/tasks/ODD-1/terminal', { key: 'C-c' })).statusCode, 200);
  let last;
  const read = async () => { last = (await inject('GET', '/api/tasks/ODD-1/terminal')).json(); return last; };
  await until(async () => (await read()).dead, 'the exit', undefined, () => last);
  // The code comes from tmux (pane_dead_status). On the Mac it is there with the dead pane. On the Linux
  // runner of CI tmux 3.4 (built with libutempter) lost the signal of the exit in 2 runs of 3: the pane dead,
  // it sees a dead pane without a code (`nudgeLostExit`), so the code must come everywhere; when it does not,
  // what tells the guesses apart goes into the log first.
  for (const end = Date.now() + 4000; last.exit === null && Date.now() < end;) {
    await new Promise((r) => { setTimeout(r, 50); });
    await read();
  }
  if (last.exit === null) await exitDiagnosis(t, last.session);
  assert.equal(last.exit, 3, JSON.stringify(last).slice(0, 300));
  const st = last;
  assert.match(st.screen, /fake claude ready/);
  assert.equal((await inject('POST', '/api/tasks/ODD-1/terminal', { text: 'x' })).statusCode, 409);
  assert.equal((await inject('DELETE', '/api/tasks/ODD-1/terminal')).statusCode, 200);
  assert.deepEqual((await inject('GET', '/api/tasks/ODD-2/terminal')).json(), { session: null });
  assert.equal((await inject('DELETE', '/api/tasks/ODD-1/terminal')).statusCode, 404);
});

test('a dead pane without an exit code nudges its tmux server once, and only such a pane', async () => {
  const sent = [];
  const kill = (pid, sig) => sent.push([pid, sig]);
  const lost = { dead: true, exit: null, server: 4242 };
  const after = await phantom.nudgeLostExit('n-1', lost, async () => ({ ...lost, exit: 3 }), kill);
  assert.equal(after.exit, 3, 'the state was not read again after the nudge');
  assert.deepEqual(sent, [[4242, 'SIGCHLD']]);
  assert.equal((await phantom.nudgeLostExit('n-1', lost, async () => ({ ...lost, exit: 3 }), kill)).exit, null, 'the same pane was nudged twice');
  for (const [sid, st] of [['n-2', { dead: true, exit: 0, server: 1 }], ['n-3', { dead: false, server: 1 }], ['n-4', { dead: true, exit: null, server: null }], ['n-5', null]]) {
    await phantom.nudgeLostExit(sid, st, async () => st, kill);
  }
  assert.equal(sent.length, 1, `a pane that needed no nudge got one: ${JSON.stringify(sent)}`);
});

test('a Claude killed by a signal has no exit code: the one nudge goes to the tmux server of the board\'s own socket', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('sig', 'SIG', 'Sig', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  const s = await launchOn('sig', ['SIG-1']);
  const standIn = entries().find((e) => e.argv?.includes(s)).pid;
  const server = Number(execFileSync(TMUX, ['-L', SOCKET, 'display-message', '-p', '#{pid}']).toString().trim());
  const sent = [];
  const real = process.kill;
  process.kill = (pid, sig) => { if (sig === 'SIGCHLD') sent.push(pid); return real.call(process, pid, sig); };
  let last;
  try {
    real.call(process, standIn, 'SIGKILL');
    await until(async () => { last = (await inject('GET', '/api/tasks/SIG-1/terminal')).json(); return last.dead; }, 'the killed Claude', undefined, () => last);
    for (let i = 0; i < 4; i++) last = (await inject('GET', '/api/tasks/SIG-1/terminal')).json(); // the card looks every second
  } finally {
    process.kill = real;
  }
  assert.equal(last.exit, null, `a Claude killed by a signal came with an exit code: ${JSON.stringify(last).slice(0, 200)}`);
  assert.deepEqual(sent, [server], `SIGCHLD went to ${JSON.stringify(sent)}; the tmux server of the socket is ${server}, the killed Claude was ${standIn}`);
  assert.equal((await inject('DELETE', '/api/tasks/SIG-1/terminal')).statusCode, 200);
});

test('a running Claude is stopped from the card', { skip }, async () => {
  const r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do PLN-1', project: 'plain', keys: ['PLN-1'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().trusted, true);
  const s = r.json().session;
  await until(() => entries().some((e) => e.argv?.includes(s)), 'the second start');
  const args = entries().find((e) => e.argv?.includes(s)).argv;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto', 'the default is the auto mode');
  assert.equal((await inject('DELETE', '/api/tasks/PLN-1/terminal')).json().session, s);
  assert.deepEqual((await inject('GET', '/api/tasks/PLN-1/terminal')).json(), { session: null });
});

const alive = async (key) => Boolean((await inject('GET', `/api/tasks/${key}/terminal`)).json().session);
const hasSession = (s) => { try { execFileSync(TMUX, ['-L', SOCKET, 'has-session', '-t', `=kb-${s}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const panePid = (s) => Number(execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', `=kb-${s}:`, '-F', '#{pane_pid}']).toString().trim());
// Claude Code's own registry of live sessions: <claude dir>/sessions/<pid>.json
const register = (pid, sessionId, status, since = Date.now()) => {
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, status, statusUpdatedAt: since }));
};
const unregister = (pid) => rmSync(join(claudeDir, 'sessions', `${pid}.json`), { force: true });
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
async function launchOn(project, keys) {
  const r = await inject('POST', '/api/launch', { mode: 'board', text: `Do ${keys.join(' ')}`, project, keys });
  assert.equal(r.statusCode, 200, r.body);
  await until(() => alive(keys[0]), `the start on ${keys[0]}`);
  // the stand-in itself is up — tmux has the session a moment before the program inside it listens
  await until(() => entries().some((e) => e.argv?.includes(r.json().session)), `the stand-in on ${keys[0]}`);
  return r.json().session;
}

test('words typed to the terminal of a task back in To do move it to Preparation, as the move of its Claude', { skip }, async () => {
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('again', 'AGN', 'Again', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pid);
  const s = await launchOn('again', ['AGN-1']);
  const status = () => db.prepare("SELECT status FROM tasks WHERE project_id = ? AND task_no = 1").get(pid).status;
  const last = () => db.prepare("SELECT e.status, e.session_id, l.event_id AS launch FROM task_events e JOIN tasks t ON t.id = e.task_id LEFT JOIN task_launches l ON l.event_id = e.id WHERE t.project_id = ? ORDER BY e.id DESC LIMIT 1").get(pid);
  assert.equal((await inject('PATCH', '/api/tasks/AGN-1', { status: 'review' })).statusCode, 200);
  assert.equal((await inject('PATCH', '/api/tasks/AGN-1', { status: 'todo' })).statusCode, 200, 'the person puts it back');
  let r = await inject('POST', '/api/tasks/AGN-1/terminal', { key: 'Escape' });
  assert.deepEqual(r.json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'todo', 'a key alone moved the task');
  r = await inject('POST', '/api/tasks/AGN-1/terminal', { text: '   ', key: 'Enter' });
  assert.equal(status(), 'todo', 'blank words moved the task');
  r = await inject('POST', '/api/tasks/AGN-1/terminal', { text: '1' });
  assert.equal(status(), 'todo', 'the digit that answers a question of Claude moved the task');
  r = await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'one more thing', key: 'Enter' });
  assert.deepEqual(r.json(), { ok: true, prep: ['AGN-1'], doing: [] });
  assert.equal(status(), 'prep');
  assert.deepEqual(last(), { status: 'prep', session_id: s, launch: null }, 'the move is not its Claude\'s, or is marked as a start');
  const take = (sid) => app.inject({ method: 'PATCH', url: '/api/tasks/AGN-1', payload: { status: 'prep' }, headers: { 'x-claude-session': sid } });
  assert.equal((await take(s)).statusCode, 200, 'its Claude lost the task');
  assert.equal((await take('22222222-2222-2222-2222-222222222222')).statusCode, 409, 'another Claude may take it');
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'and this' })).json(), { ok: true, prep: [], doing: [] }, 'a task in work moved again');
  // question of Claude's) and keys alone are not
  await inject('PATCH', '/api/tasks/AGN-1', { status: 'review' });
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: '2' })).json(), { ok: true, prep: [], doing: [] });
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { key: 'Enter' })).json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'review', 'a digit or a key moved the task in Review');
  for (const cmd of ['/login', ' /exit'])
    assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: cmd, key: 'Enter' })).json(), { ok: true, prep: [], doing: [] }, `${cmd} moved the task in Review`);
  assert.equal(status(), 'review', 'a slash command moved the task in Review');
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'and in Review' })).json(), { ok: true, prep: [], doing: ['AGN-1'] });
  assert.equal(status(), 'doing', 'words typed in Review left the task there');
  assert.deepEqual(last(), { status: 'doing', session_id: s, launch: null });
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'again' })).json(), { ok: true, prep: [], doing: [] });
  await inject('PATCH', '/api/tasks/AGN-1', { status: 'review' });
  execFileSync(TMUX, ['-L', SOCKET, 'send-keys', '-t', `=kb-${s}:`, '-l', 'ASK']);
  await until(() => phantom.questionOpen(execFileSync(TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', `=kb-${s}:`]).toString()), 'the question on the screen');
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'no thanks', key: 'Enter' })).json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'review', 'an answer to a question of Claude moved the task in Review');
  // close the question: with it open nothing below would move anyway, and the manual task went unguarded
  await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'ANSWERED' });
  await until(() => !phantom.questionOpen(execFileSync(TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', `=kb-${s}:`]).toString()), 'the question closed');
  assert.equal(status(), 'review', 'the answer to the question moved the task');
  await inject('PATCH', '/api/tasks/AGN-1', { status: 'todo' });
  await inject('PATCH', '/api/tasks/AGN-1', { labels: ['noclaude'] });
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'by hand now' })).json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'todo', 'a manual task went to a column of Claude');
  await inject('PATCH', '/api/tasks/AGN-1', { status: 'review' });
  assert.deepEqual((await inject('POST', '/api/tasks/AGN-1/terminal', { text: 'by hand in Review' })).json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'review', 'a manual task in Review went to a column of Claude');
  assert.equal((await inject('DELETE', '/api/tasks/AGN-1/terminal')).statusCode, 200);
});

test('words typed after a hand-in, about the next task, leave the handed-in task in Review', { skip }, async () => {
  // a repository of its own: undoing the words must not hand this task the commit of the next one
  const repo = mkdtempSync(join(tmp, 'next-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('next', 'NXT', 'Next', 8, ?)").run(repo).lastInsertRowid;
  for (const n of [1, 2, 3, 4, 5, 6, 7]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('next', ['NXT-1']);
  const as = (sid, method, url, payload) => app.inject({ method, url, payload, headers: { 'x-claude-session': sid } });
  const move = async (n, status, sid = s) => assert.equal((await as(sid, 'PATCH', `/api/tasks/NXT-${n}`, { status })).statusCode, 200);
  const row = (n) => db.prepare('SELECT status, work_seconds FROM tasks WHERE project_id = ? AND task_no = ?').get(pidp, n);
  const handIn = async () => {
    await move(1, 'review');
    db.prepare('UPDATE tasks SET work_seconds = 600 WHERE project_id = ? AND task_no = 1').run(pidp);
    assert.deepEqual((await inject('POST', '/api/tasks/NXT-1/terminal', { text: 'okay, take the next one', key: 'Enter' })).json(), { ok: true, prep: [], doing: ['NXT-1'] });
    assert.equal(row(1).status, 'doing', 'words in Review no longer move the task (CK-609)');
  };
  await handIn();
  // another Claude taking a task says nothing about these words
  await move(4, 'prep', '33333333-3333-3333-3333-333333333333');
  assert.equal(row(1).status, 'doing', 'another session\'s move settled the words');
  // Claude worked on the next task for five minutes before taking it to prep
  db.prepare("UPDATE tasks SET work_started_at = datetime('now', '-300 seconds') WHERE project_id = ? AND task_no = 1").run(pidp);
  git('commit', '-q', '--allow-empty', '-m', 'the next task');
  await move(2, 'prep');
  assert.deepEqual(row(1), { status: 'review', work_seconds: 600 }, 'the handed-in task stayed in Doing, or kept the other task\'s minutes');
  await pause(500); // git answers the board in a callback
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ? AND t.task_no = 1 AND c.author = 'git'").get(pidp).n, 0, 'the commit of the next task was hung on the handed-in one');
  const last = db.prepare("SELECT e.status, e.session_id FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND t.task_no = 1 ORDER BY e.id DESC LIMIT 1").get(pidp);
  assert.deepEqual(last, { status: 'review', session_id: null }, 'the undoing is the session\'s move');
  const { sessionWindows, sessionEvents } = await import('../src/work-feed.js');
  const open = sessionWindows(sessionEvents(s)).filter((w) => w.to === null);
  assert.deepEqual(open.map((w) => w.task_id), [db.prepare('SELECT id FROM tasks WHERE project_id = ? AND task_no = 2').get(pidp).id],
    'the task the session went on to has no focus, and its card does not say Claude works on it');
  // a task already in work going on (prep → doing, doing → deploy) is taking nothing new; kb take is
  await handIn();
  await move(2, 'doing');
  assert.equal(row(1).status, 'doing', 'a task the session already had, going on, settled the words');
  const taken = await as(s, 'POST', '/api/tasks/take', { project: 'next' });
  assert.equal(taken.json().task.key, 'NXT-3');
  assert.equal(row(1).status, 'review', 'kb take left the handed-in task in Doing');
  // the words were about this task: its Claude wrote to it after them — it stays in Doing
  await handIn();
  await pause(1100); // the board's clock counts seconds
  assert.equal((await as(s, 'POST', '/api/tasks/NXT-1/comments', { author: 'claude', body: 'fixing it' })).statusCode, 201);
  await move(5, 'prep');
  assert.equal(row(1).status, 'doing', 'a task its Claude works on again went back to Review');
  await handIn();
  const other = '44444444-4444-4444-4444-444444444444';
  await move(1, 'review', other);
  await move(1, 'doing', other);
  await move(7, 'prep');
  assert.equal(row(1).status, 'doing', 'the words were undone over the moves of another session');
  await move(1, 'review');
  // long after the words Claude may be on it without a word to the board — they stand
  const { setSettleMs } = await import('../src/routes/tasks.js');
  setSettleMs(0);
  try {
    await handIn();
    await pause(5);
    await move(6, 'prep');
    assert.equal(row(1).status, 'doing', 'words of long ago were undone');
  } finally { setSettleMs(5 * 60 * 1000); }
  assert.equal((await inject('DELETE', '/api/tasks/NXT-1/terminal')).statusCode, 200);
});

test('a turn that left the task untouched sends it back to Review; a commit, a changed file or a word to it keeps it in Doing', { skip }, async () => {
  const repo = mkdtempSync(join(tmp, 'turn-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  writeFileSync(join(repo, 'a.txt'), 'one, changed before the words\n'); // a tree already dirty counts as it is
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('turn', 'TRN', 'Turn', 2, ?)").run(repo).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  const s = await launchOn('turn', ['TRN-1']);
  const { settleTurns } = await import('../src/routes/tasks.js');
  const { emit } = await import('../src/bus.js');
  const id = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND task_no = 1').get(pidp).id;
  const row = () => db.prepare('SELECT status, work_seconds FROM tasks WHERE id = ?').get(id);
  const as = (method, url, payload) => app.inject({ method, url, payload, headers: { 'x-claude-session': s } });
  const words = async (text) => {
    if (row().status !== 'review') assert.equal((await as('PATCH', '/api/tasks/TRN-1', { status: 'review' })).statusCode, 200);
    db.prepare('UPDATE tasks SET work_seconds = 600 WHERE id = ?').run(id);
    const at = Date.now();
    assert.deepEqual((await inject('POST', '/api/tasks/TRN-1/terminal', { text, key: 'Enter' })).json(), { ok: true, prep: [], doing: ['TRN-1'] });
    await pause(300); // git reads the tree as the words found it — Claude takes longer than that to change it
    return at;
  };
  const turn = (claude, since) => settleTurns([{ id, status: row().status, claude, since }]);

  // «put it into Review» — Claude does, and the words have nothing left to undo
  let at = await words('put TRN-1 into Review so I check it later');
  assert.equal((await as('PATCH', '/api/tasks/TRN-1', { status: 'review' })).statusCode, 200);
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'review');

  // «add a task to the backlog»: while the turn goes on — and at a prompt that was idle before the words — nothing moves
  at = await words('add a task to the backlog');
  assert.deepEqual(await turn('busy', Date.now() + 1), [], 'a turn still going on settled the words');
  assert.deepEqual(await turn('waiting', Date.now() + 1), [], 'a question of Claude settled the words');
  assert.deepEqual(await turn('idle', at - 1), [], 'a prompt idle from before the words settled them');
  assert.equal(row().status, 'doing');
  // the turn is over and the task untouched: back to Review with the time it had — by the live watch's own event
  emit('task.live', { tasks: [{ id, status: 'doing', claude: 'idle', since: Date.now() + 1 }], questions: [], projects: [] });
  await until(() => row().status === 'review', 'the task back in Review after the turn');
  assert.deepEqual(row(), { status: 'review', work_seconds: 600 }, 'the task kept the minutes of the turn');
  const ev = (await inject('GET', '/api/tasks/TRN-1')).json().events.slice(-2);
  assert.deepEqual(ev.map((e) => [e.status, e.typed]), [['doing', 'typed-undone'], ['review', 'settled']], 'the timeline does not say who moved it');

  // a commit in the turn: the words were about the task
  at = await words('fix the button too');
  git('commit', '-q', '--allow-empty', '-m', 'the button');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a turn that committed sent the task back to Review');
  // a changed file, committed nothing
  at = await words('and the margin');
  writeFileSync(join(repo, 'a.txt'), 'one, and the margin\n');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a turn that changed a file sent the task back to Review');
  // a new file
  at = await words('and a note');
  writeFileSync(join(repo, 'note.txt'), 'new\n');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a turn that made a file sent the task back to Review');
  // a word of its Claude to the task
  at = await words('why is it so?');
  await pause(1100); // the board's clock counts seconds: the word of Claude comes after the move
  assert.equal((await as('POST', '/api/tasks/TRN-1/comments', { author: 'claude', body: 'because' })).statusCode, 201);
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a turn that wrote to the task sent it back to Review');
  assert.equal((await inject('GET', '/api/tasks/TRN-1')).json().events.at(-1).typed, 'typed', 'a move by typed words is not marked');

  // a folder that is no git repository: the board cannot tell Claude did nothing — the words stand
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(plain, pidp);
  at = await words('and this');
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(repo, pidp);
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a tree that cannot be compared sent the task back to Review');
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(plain, pidp);
  at = await words('and that');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a folder with no git at both ends sent the task back to Review');
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(repo, pidp);
  // diff stay the same, the file does not
  at = await words('and the note again');
  await pause(20); // the time of change the print takes is the file system's
  writeFileSync(join(repo, 'note.txt'), 'new, edited again\n');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'a turn that edited an untracked file sent the task back to Review');
  // the project a folder inside a bigger repository: the untracked file is found from the repository's root
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'x.txt'), 'x\n');
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(join(repo, 'sub'), pidp);
  at = await words('and x');
  await pause(20);
  writeFileSync(join(repo, 'sub', 'x.txt'), 'x, edited\n');
  assert.deepEqual(await turn('idle', Date.now() + 1), []);
  assert.equal(row().status, 'doing', 'an untracked file edited in a project folder inside its repository sent the task back');
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(repo, pidp);
  assert.equal((await inject('DELETE', '/api/tasks/TRN-1/terminal')).statusCode, 200);
});

test('words about the task the session already works on leave the handed-in one in Review, files changed or not', { skip }, async () => {
  const repo = mkdtempSync(join(tmp, 'other-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('psx', 'PSX', 'Other', 3, ?)").run(repo).lastInsertRowid;
  for (const n of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('psx', ['PSX-1', 'PSX-2']);
  const as = (method, url, payload) => app.inject({ method, url, payload, headers: { 'x-claude-session': s } });
  const move = async (n, status) => assert.equal((await as('PATCH', `/api/tasks/PSX-${n}`, { status })).statusCode, 200);
  const idOf = (n) => db.prepare('SELECT id FROM tasks WHERE project_id = ? AND task_no = ?').get(pidp, n).id;
  const st = (n) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(idOf(n)).status;
  const { settleTurns } = await import('../src/routes/tasks.js');
  const { sessionWindows, sessionEvents } = await import('../src/work-feed.js');
  const focus = () => sessionWindows(sessionEvents(s)).find((w) => w.to === null)?.task_id;
  for (const files of [false, true]) {
    await move(1, 'doing');
    await move(1, 'review'); // handed in
    if (st(2) !== 'doing') await move(2, 'doing'); // the other one in work
    await pause(1100); // the board's clock counts seconds
    assert.deepEqual((await inject('POST', '/api/tasks/PSX-1/terminal', { text: 'now fix the header of PSX-2', key: 'Enter' })).json().doing, ['PSX-1']);
    await pause(1100);
    if (files) writeFileSync(join(repo, 'a.txt'), `the header of PSX-2 ${Date.now()}\n`);
    await move(2, 'deploy');
    assert.equal(st(1), 'doing');
    await settleTurns([{ id: idOf(1), status: st(1), claude: 'idle', since: Date.now() + 1 }]);
    assert.equal(st(1), 'review', `words about the other task left the handed-in one in Doing${files ? ' — the files changed were the other task\'s' : ''}`);
    assert.equal(focus(), idOf(2), 'the session\'s focus stayed on the handed-in task');
    await move(2, 'doing');
  }
  assert.equal((await inject('DELETE', '/api/tasks/PSX-1/terminal')).statusCode, 200);
});

test('a word to the terminal of a check report makes no second open check', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('rep', 'REP', 'Report', 3, ?)").run(plain).lastInsertRowid;
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, 1, 'Check', 'todo', '["check"]')`).run(pidp);
  const s = await launchOn('rep', ['REP-1']);
  await inject('PATCH', '/api/tasks/REP-1', { status: 'review' });
  db.prepare(`INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, 2, 'Check again', 'todo', '["check"]')`).run(pidp);
  const status = () => db.prepare('SELECT status FROM tasks WHERE project_id = ? AND task_no = 1').get(pidp).status;
  assert.deepEqual((await inject('POST', '/api/tasks/REP-1/terminal', { text: 'and this', key: 'Enter' })).json(), { ok: true, prep: [], doing: [] });
  assert.equal(status(), 'review', 'the report became a second open check');
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE project_id = ? AND task_no = 2").run(pidp);
  assert.deepEqual((await inject('POST', '/api/tasks/REP-1/terminal', { text: 'and this', key: 'Enter' })).json(), { ok: true, prep: [], doing: ['REP-1'] });
  assert.equal((await inject('DELETE', '/api/tasks/REP-1/terminal')).statusCode, 200);
});

test('▶ in the Terminal on a task the board\'s Claude holds does not hand it to the new Claude', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('held', 'HLD', 'Held', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  const s = await launchOn('held', ['HLD-1']);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE project_id = ? AND task_no = 1").get(pidp).status, 'prep');
  const term = process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator';
  writeFileSync(join(tmp, 'bin', term), '#!/bin/sh\nexit 0\n');
  chmodSync(join(tmp, 'bin', term), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(tmp, 'bin')}:${path}`;
  try {
    const r = await inject('POST', '/api/launch', { mode: 'terminal', text: 'Do HLD-1', project: 'held', keys: ['HLD-1'] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().prep, []);
    const take = (sid) => app.inject({ method: 'PATCH', url: '/api/tasks/HLD-1', payload: { status: 'prep' }, headers: { 'x-claude-session': sid } });
    assert.equal((await take(r.json().session)).statusCode, 409, 'the second Claude was let to keep the task the board\'s Claude works on');
    assert.equal((await take(s)).statusCode, 200, 'the board\'s Claude lost its task');
  } finally {
    process.env.PATH = path;
    rmSync(join(tmp, 'bin', term), { force: true });
  }
  assert.equal((await inject('DELETE', '/api/tasks/HLD-1/terminal')).statusCode, 200);
});

test('a board terminal closes itself once none of its tasks is in play: Review keeps it, a batch waits for all of them', { skip }, async () => {
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('sweep', 'SWP', 'Sweep', 5, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2, 3, 4]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pid, n);
  const s = await launchOn('sweep', ['SWP-1', 'SWP-2']);
  const move = (key, status) => inject('PATCH', `/api/tasks/${key}`, { status });
  for (const key of ['SWP-1', 'SWP-2']) { await move(key, 'prep'); await move(key, 'review'); }
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'Review closed the terminal where the person answers Claude');
  assert.ok(hasSession(s));
  await move('SWP-1', 'done');
  // the move starts a sweep without waiting for it: run one to the end — a sleep would pass by itself
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'SWP-2 of the batch is still in play, and its terminal was closed');
  assert.ok(hasSession(s));
  await move('SWP-2', 'cancelled');
  await until(() => !hasSession(s), 'the terminal to close when the last task of its batch left play');
  assert.equal(await alive('SWP-1'), false);
});

test('a terminal whose tasks wait in Review closes once its Claude has been idle for hours, unless it asks or works in the background', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('rest', 'RST', 'Rest', 4, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('rest', ['RST-1', 'RST-2']);
  const move = (key, status) => inject('PATCH', `/api/tasks/${key}`, { status });
  const statusOf = (key) => db.prepare("SELECT status FROM tasks WHERE project_id = ? AND task_no = ?").get(pidp, Number(key.split('-')[1])).status;
  await move('RST-1', 'review');
  await move('RST-2', 'doing');
  const pid = panePid(s);
  const long = Date.now() - phantom.RESTING_MAX_MS - 60_000;
  register(pid, s, 'idle', long);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a terminal with a task at work was closed');
  for (const st of ['prep', 'deploy']) {
    db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND task_no = 2').run(st, pidp);
    assert.deepEqual(await phantom.closeFinishedTerminals(), [], `a terminal with a task in ${st} was closed`);
  }
  await move('RST-2', 'backlog');
  register(pid, s, 'idle', Date.now() - phantom.RESTING_MAX_MS + 60_000);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'Review lost the terminal before Claude had rested for long');
  register(pid, s, 'busy', long);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a busy Claude was cut off');
  register(pid, s, 'waiting', long);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a Claude waiting for an answer was closed');
  register(pid, s, 'idle', long);
  const type = (text) => execFileSync(TMUX, ['-L', SOCKET, 'send-keys', '-t', `=kb-${s}:`, '-l', text]);
  const screen = () => execFileSync(TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', `=kb-${s}:`]).toString();
  type('LIMIT'); // the input box with "1 shell" under it
  await until(() => phantom.backgroundOnScreen(screen()), 'the background shell on the screen');
  assert.equal(phantom.questionOpen(screen()), false);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a Claude with a command running in the background was closed');
  type('QUIET');
  await until(() => !phantom.backgroundOnScreen(screen()), 'the background shell to end');
  type('ASK');
  await until(() => phantom.questionOpen(screen()), 'the question on the screen');
  assert.equal(phantom.backgroundOnScreen(screen()), false);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a Claude asking a question was closed');
  type('MANY'); // the question scrolls away
  type('QUIET'); // the input box again, nothing under it
  await until(() => /for shortcuts\s*$/.test(screen()) && !phantom.backgroundOnScreen(screen()) && !phantom.questionOpen(screen()), 'a quiet screen');
  assert.equal(statusOf('RST-1'), 'review');
  phantom.setLookHold(phantom.LOOK_HOLD_MS);
  try {
    assert.equal((await inject('GET', '/api/tasks/RST-1/terminal')).json().session, s);
    assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'the terminal was closed under the card that looks at it');
  } finally { phantom.setLookHold(0); }
  assert.deepEqual(await phantom.closeFinishedTerminals(), [s], 'a terminal idle for hours with its tasks in Review lived on');
  assert.ok(!hasSession(s));
  unregister(pid);
});

test('a resting Claude after /clear, and a Claude that exited with its task in Review, close too', { skip }, async () => {
  const pidp = db.prepare("SELECT id FROM projects WHERE slug = 'rest'").get().id;
  for (const n of [4, 5, 6]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('rest', ['RST-4']);
  const pid = panePid(s);
  const renewed = 'cdcdcdcd-abab-4efe-8a8a-bcbcbcbcbcbc';
  const as = (sid, key, st) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': sid }, payload: { status: st } });
  await as(renewed, 'RST-5', 'prep');
  await as(renewed, 'RST-5', 'review');
  await inject('PATCH', '/api/tasks/RST-4', { status: 'done' });
  register(pid, renewed, 'idle');
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a Claude that just handed in under its new id was closed');
  register(pid, renewed, 'idle', Date.now() - phantom.RESTING_MAX_MS - 60_000);
  db.prepare("UPDATE tasks SET status = 'doing' WHERE project_id = ? AND task_no = 5").run(pidp);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a Claude at work under its new id was closed');
  db.prepare("UPDATE tasks SET status = 'review' WHERE project_id = ? AND task_no = 5").run(pidp);
  assert.deepEqual(await phantom.closeFinishedTerminals(), [s], 'a Claude resting for hours under its new id was kept for good');
  unregister(pid);

  const d = await launchOn('rest', ['RST-6']);
  await inject('PATCH', '/api/tasks/RST-6', { status: 'review' });
  execFileSync(TMUX, ['-L', SOCKET, 'send-keys', '-t', `=kb-${d}:`, 'C-c']); // the stand-in exits on Ctrl+C
  await until(() => execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', `=kb-${d}:`, '-F', '#{pane_dead}']).toString().trim() === '1', 'Claude to exit');
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'the last screen of a Claude that just exited was taken away');
  phantom.setRestingMax(0);
  try { assert.deepEqual(await phantom.closeFinishedTerminals(), [d], 'the last screen of a Claude that exited hours ago stays for good'); } finally { phantom.setRestingMax(phantom.RESTING_MAX_MS); }
});

test('a Claude that exited where tmux lost its exit has its last screen closed too, counted from the first sweep that saw it', { skip }, async () => {
  const pidp = db.prepare("SELECT id FROM projects WHERE slug = 'rest'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 7, 'T', 'todo')").run(pidp);
  const d = await launchOn('rest', ['RST-7']);
  await inject('PATCH', '/api/tasks/RST-7', { status: 'review' });
  execFileSync(TMUX, ['-L', SOCKET, 'send-keys', '-t', `=kb-${d}:`, 'C-c']);
  await until(() => execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', `=kb-${d}:`, '-F', '#{pane_dead}']).toString().trim() === '1', 'Claude to exit');
  const lost = join(standIn(), 'lost-time');
  writeFileSync(lost, '');
  try {
    await viaStandIn(async () => {
      assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'the last screen of a Claude that just exited was taken away');
      phantom.setRestingMax(0);
      try { assert.deepEqual(await phantom.closeFinishedTerminals(), [d], 'with no time from tmux the last screen stays for good'); } finally { phantom.setRestingMax(phantom.RESTING_MAX_MS); }
    });
  } finally { rmSync(lost, { force: true }); }
  assert.ok(!hasSession(d));
});

test('a Claude in the middle of a turn is left to finish; the next sweep closes it', { skip }, async () => {
  const s = await launchOn('sweep', ['SWP-3']);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix = 'SWP' AND t.task_no = 3)").run();
  const pid = panePid(s);
  register(pid, s, 'busy');
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a busy Claude was cut off mid-turn');
  assert.ok(hasSession(s));
  register(pid, s, 'shell');
  assert.deepEqual(await phantom.closeFinishedTerminals(), [s], 'a `shell` Claude of accepted tasks was kept as one mid-turn');
  assert.ok(!hasSession(s));
  unregister(pid);
});

test('a terminal whose Claude was busy when its task was deleted closes once Claude stops', { skip }, async () => {
  // found by the review: the ties to the task go with it, and the board knew the session was its own only
  // during the one sweep right after the delete — a busy Claude then was left running for good
  const pidp = db.prepare("SELECT id FROM projects WHERE slug = 'sweep'").get().id;
  for (const n of [5, 6, 7]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('sweep', ['SWP-5']);
  const pid = panePid(s);
  register(pid, s, 'busy');
  // one at a time), so the registry below changes only after both have looked. Before, on a busy machine the
  // delete's sweep was still looking at the socket when Claude turned idle, closed the terminal itself, and the
  // test's sweep got [] — «outlived it», while the terminal was closed. The stand-in makes that timing every
  // time: the delete's look at the socket takes 0.8 s, the test's first none, its second 1.6 s
  slowSweeps(0.8, 0, 1.6);
  const closed = await viaStandIn(async () => {
    assert.equal((await inject('DELETE', '/api/tasks/SWP-5')).statusCode, 204);
    await until(() => !existsSync(join(standIn(), 'slow-1')), "the delete's sweep to look at the socket");
    assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'a busy Claude was cut off mid-turn');
    assert.ok(hasSession(s), 'a busy Claude was cut off mid-turn');
    register(pid, s, 'idle');
    return phantom.closeFinishedTerminals();
  });
  assert.ok(!existsSync(join(standIn(), 'slow-3')), 'the sweeps did not go through the stand-in');
  assert.ok(!hasSession(s), 'the terminal of a deleted task outlived it');
  assert.deepEqual(closed, [s], 'a sweep of the board closed the terminal behind the back of the one called after it');
  unregister(pid);
});

test('after /clear the same Claude goes on under a new id: accepting the task it was started for does not close it', { skip }, async () => {
  const s = await launchOn('sweep', ['SWP-6']);
  const pid = panePid(s);
  const renewed = 'abababab-cdcd-4efe-8a8a-bcbcbcbcbcbc';
  register(pid, renewed, 'idle'); // /clear gives the conversation a new id; the process stays the same
  await app.inject({ method: 'PATCH', url: '/api/tasks/SWP-7', headers: { 'x-claude-session': renewed }, payload: { status: 'prep' } });
  await inject('PATCH', '/api/tasks/SWP-6', { status: 'prep' });
  assert.equal((await inject('PATCH', '/api/tasks/SWP-6', { status: 'done' })).json().status, 'done');
  assert.deepEqual(await phantom.closeFinishedTerminals(), [], 'the Claude that works on SWP-7 under its new id was closed with SWP-6');
  assert.ok(hasSession(s));
  assert.equal((await inject('PATCH', '/api/tasks/SWP-7', { status: 'done' })).json().status, 'done');
  await until(() => !hasSession(s), 'the terminal to close once the task of its new id is out of play too');
  unregister(pid);
});

test('deleting a task, or the demo, closes its terminal; a session another board started on the socket is left alone', { skip }, async () => {
  const foreign = '55555555-5555-4555-8555-555555555555';
  const s = await launchOn('sweep', ['SWP-4']);
  // made while the board's session keeps the tmux server up: right after the last session of the socket has
  execFileSync(TMUX, ['-L', SOCKET, 'new-session', '-d', '-s', `kb-${foreign}`, 'sleep 600']);
  assert.equal((await inject('DELETE', '/api/tasks/SWP-4')).statusCode, 204);
  await until(() => !hasSession(s), 'the terminal of a deleted task to close');
  const demo = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('demo', 'DMO', 'Demo', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(demo);
  const d = await launchOn('demo', ['DMO-1']);
  assert.equal((await inject('DELETE', '/api/projects/demo')).statusCode, 200);
  await until(() => !hasSession(d), 'the terminal of the deleted demo to close');
  assert.deepEqual(await phantom.closeFinishedTerminals(), []);
  assert.ok(hasSession(foreign), "the sweep closed a session this board does not know — another board's on the same socket");
  execFileSync(TMUX, ['-L', SOCKET, 'kill-session', '-t', `=kb-${foreign}`]);
});

test('Claude\'s window is laid out for the card\'s screen, not the card for the window', { skip }, async () => {
  // of the tab; now it keeps its width, sends how many columns its screen holds, and the window follows
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('width', 'WID', 'Width', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pid);
  const s = await launchOn('width', ['WID-1']);
  const width = () => Number(execFileSync(TMUX, ['-L', SOCKET, 'display-message', '-p', '-t', `=kb-${s}:`, '#{window_width}']).toString().trim());
  assert.equal(width(), phantom.COLS, 'a new session does not start as wide as the card');
  const look = (q) => inject('GET', `/api/tasks/WID-1/terminal${q}`);
  assert.equal((await look('?cols=52')).json().cols, 52);
  assert.equal(width(), 52);
  await until(() => entries().some((e) => e.resized === 52), 'Claude to learn its new width');
  for (const bad of ['10', '301', '4.5', 'abc', '', '52&cols=60']) assert.equal((await look(`?cols=${bad}`)).statusCode, 400, `cols=${bad}`);
  assert.equal((await look('')).json().cols, 52, 'a look without cols changed the width');
  assert.equal(width(), 52);
  // the same card measures 46 in Chromium and 45 in Safari: a column or two wider is not worth a redraw,
  // or two of them open at once would lay the window out again every second, one after the other
  assert.equal((await look('?cols=54')).json().cols, 52);
  assert.equal((await look('?cols=51')).json().cols, 51, 'a narrower card is not followed');
  assert.equal((await look('?cols=52')).json().cols, 51);
  assert.equal(width(), 51);
  // take the window from it, and the two would lay it out in turns every second
  await look('?cols=51');
  assert.equal((await look('?cols=70')).json().cols, 51, 'a wider viewer took the window from a narrower one still looking');
  assert.equal(width(), 51);
  assert.equal((await inject('POST', '/api/tasks/WID-1/terminal', { key: 'C-c' })).statusCode, 200);
  await until(async () => (await look('')).json().dead, 'Claude to exit');
  await look('?cols=60');
  assert.equal(width(), 51, 'the last screen of a Claude that has exited was laid out again — nobody is there to redraw it');
  assert.equal((await inject('DELETE', '/api/tasks/WID-1/terminal')).statusCode, 200);
});

test('the card keeps its width on the Terminal tab and tells the server how many columns its screen holds', () => {
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(drawer, /classList\.(toggle|add)\('term-wide'/, 'the Terminal tab widens the card again');
  const own = css.replace(/body:has\(#now:not\(\.hidden\)\) \.drawer\.is-empty \{[^}]*\}/g, '')
    .replace(/(?:html\[data-design="v3"\] )?\.drawer\.drawer-full \{[^}]*position: fixed[^}]*\}/g, '');
  assert.doesNotMatch(own, /\.drawer\.[\w-]+\s*\{[^}]*width/, 'a state of the drawer sets its own width');
  assert.match(drawer, /if \(cols\) q\.set\('cols', cols\);/, 'the screen is fetched without the columns it holds');
});

test('the Terminal tab looks again only once its last look came back, and gets the screen only when it changed', () => {
  // 19–29 KB each, the same screen 9 times out of 9
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(drawer, /setInterval\(pollTerminal/, 'a look goes out before the last one came back');
  assert.match(drawer, /async function termTick\(chain\) \{\n  await pollTerminal\(\);\n  if \(chain === termChain\) termSchedule\(TERM_POLL_MS, chain\);/,
    'the next look is not timed from the answer to the last one');
  assert.match(drawer, /if \(termSeen\) q\.set\('seen', termSeen\);/, 'the card does not say which screen it has');
  assert.match(drawer, /if \(r\.same\) return;\n  termSeen = r\.v \|\| null;\n  renderTerminal\(r\);/);
  // the card of another task starts with no screen and no `seen` of the last one — none of the three had a guard
  assert.match(drawer, /if \(n !== termReq \|\| key !== termKey \|\| key !== state\.drawerKey\) return;/, 'the screen of the last task is drawn in the card of the next');
  assert.match(drawer, /if \(termKey !== t\.key\) \{ termScreen = null; termFollow = true; \}/, 'the card of another task starts with the last screen');
  assert.match(drawer, /screen: termScreen \?\? '' \}\);\s*termSeen = null;/, 'the card drawn from memory says it has the screen of the server');
});

test('an open question is told from Claude at its prompt by the bottom of the screen, wrapped or not', () => {
  // and a digit in the text ("add 2 tests") picks option 2. The review: the window is 45 columns now, and
  // the footer "Enter to select · ↑/↓ to navigate · Esc to cancel" (49) no longer fits in one row.
  const { questionOpen, busyOnScreen } = phantom;
  // the shapes of the owner's real screens (03.10.2026), laid out 45 columns wide
  const prompt = (input, spinner = '✻ Sautéed for 16s · done 4:56 PM') => ['● DEMO-280 is in Review.', spinner, `${'─'.repeat(34)} DEMO-280 ─`, `❯\u00a0${input}`, '─'.repeat(45),
    '  ⬆ /gsd-update │ Opus 5.5 (1M context) │', '  demo ░░░░░░░░░░ 7%', '  ⏵⏵ auto mode on (shift+tab to cycle) · ←', '  for agents', '', ''].join('\n');
  assert.equal(questionOpen(prompt('прими DEMO-280')), false, 'Claude at its prompt (the dim suggestion in an empty input reads as text)');
  assert.equal(questionOpen('Which color?\n❯ 1. Orange\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to\ncancel\n\n'), true, 'a footer wrapped by the narrow window');
  assert.equal(questionOpen('Which color?\n❯ 1. Orange\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel'), true, 'a question Claude asks');
  assert.equal(questionOpen('Bash command\n  kb done DEMO-1\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and switch to auto mode\n  3. No\n\nEsc to cancel · Tab to amend\n'), true, 'a permission question');
  assert.equal(questionOpen('Do you trust the files in this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to exit'), true, 'the trust question of a new folder');
  assert.equal(questionOpen(`Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel\n${prompt('')}`), false, 'a question answered long ago, still in the scrollback');
  assert.equal(questionOpen(''), false);
  const above = ['  обновляется. Добавил тест на оба правила;', '', '─'.repeat(45), '  Teach auto mode about your environment?', '',
    '  Auto mode works better when it knows your', '  environment. Takes about a minute.', '', '  ❯ 1. Yes', '    2. Not now', "    3. Don't show again", '',
    '  Enter to confirm · Esc to cancel', `${'─'.repeat(33)} CK-583 +1 ─`, '❯ ', '─'.repeat(45), '  ⬆ /gsd-update │ Opus 5.5 (1M context) │ …',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ←…'].join('\n');
  assert.equal(questionOpen(above), true, 'a question above the input box');
  assert.equal(questionOpen(above.replace('Enter to confirm · Esc to cancel', 'Enter to confirm · Esc to\ncancel')), true, 'its footer wrapped');
  assert.equal(questionOpen(`Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel\n● Done.\n${prompt('')}`), false, 'an answered question, one line of Claude after it');
  assert.equal(questionOpen(prompt('Enter to confirm')), false, 'the words typed into the input');
  const quoted = ['● Готово: вопрос с подвалом', '  «Enter to confirm · Esc to cancel» виден.', '─'.repeat(45), '❯ ', '─'.repeat(45), '  ? for shortcuts'].join('\n');
  assert.equal(questionOpen(quoted), false, 'Claude quoting the footer read as a question');
  const status = (n) => Array.from({ length: n }, (_, i) => `  status ${i + 1}`);
  const withStatus = (n) => [...above.split('\n').slice(0, 16), ...status(n)].join('\n');
  assert.equal(questionOpen(withStatus(4)), true, 'a question above the input box with four status lines under it');
  assert.equal(questionOpen(withStatus(5)), false, 'five lines under a box are not the status lines of an input box');
  assert.equal(questionOpen(above.replace('\n❯ \n', '\n  some text\n')), false, 'a box with no ❯ in it read as the input box');
  assert.equal(questionOpen(quoted.replace('виден.', 'Enter to confirm · Esc to cancel')), false, 'a bare footer line of Claude read as a question');
  const listed = ['● Готово:', '  1. Исправил проверку подвала', '  2. Добавил тест', '  «Enter to confirm · Esc to cancel» виден.', '─'.repeat(45), '❯ ', '─'.repeat(45), '  ? for shortcuts'].join('\n');
  assert.equal(questionOpen(listed), false, 'a numbered reply of Claude quoting the footer read as a question');
  assert.equal(busyOnScreen(prompt('', '✻ Churning… (esc to interrupt)')), true, 'Claude at work');
  assert.equal(busyOnScreen(prompt('')), false);
});

test('boardQuestions finds the board\'s own terminal that asks, by its screen in tmux', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('qst', 'QST', 'Qst', 3, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s1 = await launchOn('qst', ['QST-1']);
  const s2 = await launchOn('qst', ['QST-2']);
  assert.ok(!(await phantom.boardQuestions()).some((s) => s === s1 || s === s2), 'a terminal with no question on its screen asks');
  assert.equal((await inject('POST', '/api/tasks/QST-1/terminal', { text: 'ASK' })).statusCode, 200);
  await until(async () => (await phantom.boardQuestions()).includes(s1), 'the question on the screen of QST-1');
  const asking = await phantom.boardQuestions();
  assert.ok(!asking.includes(s2), 'the terminal that does not ask was named');
  db.prepare('DELETE FROM board_sessions WHERE session_id = ?').run(s1);
  try {
    assert.ok(!(await phantom.boardQuestions()).includes(s1), 'a terminal the board did not start was looked into');
  } finally { db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(s1); }
  for (const k of ['QST-1', 'QST-2']) await inject('DELETE', `/api/tasks/${k}/terminal`);
});

// limit tests hand refreshLive a made-up look; and the depth of the card's screen (1000 lines of history, the point of
test('boardLook reads the stop at the limit off a real screen, and the card\'s screen keeps a thousand lines of history', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('lim', 'LIM', 'Lim', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  const s = await launchOn('lim', ['LIM-1']);
  assert.ok(!(await phantom.boardLook()).limited.some((x) => x.sid === s), 'a terminal with no stop on its screen is taken for one at the limit');
  assert.equal((await inject('POST', '/api/tasks/LIM-1/terminal', { text: 'MANY' })).statusCode, 200);
  await until(async () => /row 1099/.test((await inject('GET', '/api/tasks/LIM-1/terminal')).json().screen || ''), 'the long output on the screen');
  const screen = (await inject('GET', '/api/tasks/LIM-1/terminal')).json().screen;
  assert.ok(screen.split('\n').length >= 1000, `the card's screen keeps ${screen.split('\n').length} lines, not a thousand`);
  assert.match(screen, /row 0150/, 'the history does not reach a thousand lines back');
  assert.equal((await inject('POST', '/api/tasks/LIM-1/terminal', { text: 'LIMIT' })).statusCode, 200);
  await until(async () => (await phantom.boardLook()).limited.some((x) => x.sid === s), 'the stop at the limit on the screen of LIM-1');
  const seen = await phantom.boardLook();
  assert.deepEqual(seen.limited.find((x) => x.sid === s), { sid: s, resets: '12:50am' });
  assert.ok(seen.live.includes(s), 'the look does not say the terminal is alive');
  assert.ok(seen.background.includes(s), 'the look does not see the command running in the background');
  assert.equal((await inject('GET', '/api/tasks/LIM-1/terminal')).json().activity, 'limit', 'the terminal of the card does not say what its Claude does');
  await inject('DELETE', '/api/tasks/LIM-1/terminal');
});

test('a comment goes to Claude only while it waits at its prompt — after the task key, as a paste', { skip }, async () => {
  // question between the look and the Enter; `!` at the start is Claude Code's shell mode, `/` a command.
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('msg', 'MSG', 'Msg', 3, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const s = await launchOn('msg', ['MSG-1']);
  const say = (text, key = 'MSG-1') => app.inject({ method: 'POST', url: `/api/tasks/${key}/terminal/message`, payload: { text } });
  const typedSince = (from) => entries().slice(from).filter((e) => e.got !== undefined).map((e) => e.got);
  for (const bad of [undefined, '', '   ', 'a\0b', 'x'.repeat(phantom.REPLY_MAX + 1), 5]) assert.equal((await say(bad)).statusCode, 400, JSON.stringify(bad)?.slice(0, 20));
  const none = await say('hi', 'MSG-2');
  assert.deepEqual([none.statusCode, none.json().reason], [404, 'gone']);
  // at the prompt — nothing in the registry for it, the screen decides
  let from = entries().length;
  const ok = await say('!rm -rf ~ is how this comment starts');
  assert.equal(ok.statusCode, 200, ok.body);
  await until(() => typedSince(from).includes('\r'), 'the Enter');
  assert.deepEqual(typedSince(from), ['\x1b[200~MSG-1: !rm -rf ~ is how this comment starts\x1b[201~', '\r'], 'not pasted whole after the task key');
  // busy, or asking, by Claude Code's registry of the process in the pane: nothing is typed
  const pid = panePid(s);
  for (const [status, reason] of [['busy', 'busy'], ['waiting', 'question']]) {
    register(pid, s, status);
    from = entries().length;
    const no = await say('добавь 2 теста');
    assert.deepEqual([no.statusCode, no.json().reason], [409, reason], status);
    await pause(250);
    assert.deepEqual(typedSince(from), [], `typed into a Claude that is ${status}`);
  }
  register(pid, s, 'shell');
  from = entries().length;
  const shell = await say('and in the background');
  assert.equal(shell.statusCode, 200, `a \`shell\` Claude was told busy: ${shell.body}`);
  await until(() => typedSince(from).includes('\r'), 'the Enter to a `shell` Claude');
  register(pid, s, 'idle');
  // an open question on the screen, its footer wrapped — nothing typed, whatever the registry says
  await inject('POST', '/api/tasks/MSG-1/terminal', { text: 'ASK' });
  await until(async () => (await inject('GET', '/api/tasks/MSG-1/terminal')).json().screen.endsWith('cancel'), 'the question on the screen');
  assert.equal((await inject('GET', '/api/tasks/MSG-1/terminal')).json().question, true, 'an open question is not told to the page');
  from = entries().length;
  const q = await say('добавь 2 теста');
  assert.deepEqual([q.statusCode, q.json().reason], [409, 'question']);
  await pause(250);
  assert.deepEqual(typedSince(from), [], 'typed into an open question');
  // answered, the question scrolls up and the next message goes
  await inject('POST', '/api/tasks/MSG-1/terminal', { text: 'ANSWERED' });
  await until(async () => (await inject('GET', '/api/tasks/MSG-1/terminal')).json().screen.endsWith('? for shortcuts'), 'the prompt again');
  assert.equal((await inject('GET', '/api/tasks/MSG-1/terminal')).json().question, false, 'a Claude at its prompt reads as waiting on a question');
  assert.equal((await say('ок')).statusCode, 200);
  // Claude has exited: gone
  assert.equal((await inject('POST', '/api/tasks/MSG-1/terminal', { key: 'C-c' })).statusCode, 200);
  await until(async () => (await inject('GET', '/api/tasks/MSG-1/terminal')).json().dead, 'Claude to exit');
  const gone = await say('ещё');
  assert.deepEqual([gone.statusCode, gone.json().reason], [409, 'gone']);
  unregister(pid);
  assert.equal((await inject('DELETE', '/api/tasks/MSG-1/terminal')).statusCode, 200);
});

test('a question that opens while the comment is being pasted gets no Enter: the text waits in Claude\'s input', { skip }, async () => {
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('msq', 'MSQ', 'Msq', 2, ?)").run(plain).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'T', 'todo')").run(pidp);
  await launchOn('msq', ['MSQ-1']);
  const from = entries().length;
  const r = await inject('POST', '/api/tasks/MSQ-1/terminal/message', { text: 'ASK which color' });
  assert.deepEqual([r.statusCode, r.json().reason, r.json().typed], [409, 'question', true], r.body);
  await pause(300);
  const typed = entries().slice(from).filter((e) => e.got !== undefined).map((e) => e.got);
  assert.deepEqual(typed, ['\x1b[200~MSQ-1: ASK which color\x1b[201~'], 'an Enter went into the question that opened');
  assert.equal((await inject('DELETE', '/api/tasks/MSQ-1/terminal')).statusCode, 200);
});

test('a Claude of the board that exited at once is a closed session at once, not "starting" for two minutes', { skip }, async () => {
  const live = await import('../src/claude-live.js');
  const nowMod = await import('../src/claude-now.js');
  const pidp = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('quit', 'QIT', 'Quit', 3, ?)").run(plain).lastInsertRowid;
  for (const n of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'T', 'todo')").run(pidp, n);
  const state = async (key) => (await live.liveTasks()).find((x) => x.key === key)?.claude;
  // a Claude that is up (the stand-in waits for input) and not in the registry yet: starting
  await launchOn('quit', ['QIT-1']);
  assert.equal(await state('QIT-1'), 'starting');
  // one that exits the moment it starts
  const quits = join(tmp, 'bin', 'claude-quits');
  writeFileSync(quits, '#!/bin/sh\necho "not signed in"\nexit 1\n');
  chmodSync(quits, 0o755);
  const was = process.env.KB_CLAUDE_BIN;
  process.env.KB_CLAUDE_BIN = quits;
  let r;
  try { r = await inject('POST', '/api/launch', { mode: 'board', text: 'Do QIT-2', project: 'quit', keys: ['QIT-2'] }); } finally { process.env.KB_CLAUDE_BIN = was; }
  assert.equal(r.statusCode, 200, r.body);
  await until(async () => (await inject('GET', '/api/tasks/QIT-2/terminal')).json().dead, 'the pane to die');
  assert.equal(await state('QIT-2'), 'gone', 'the card says "starting" over a Claude that has exited');
  const runOf = async (sid) => (await nowMod.nowRuns()).runs.find((x) => x.session === sid);
  assert.deepEqual([(await runOf(r.json().session)).claude, (await runOf(r.json().session)).stale], ['gone', true], 'Claude now keeps it among the live runs');
  // the pane taken away altogether (Stop Claude): closed too, while the start is still fresh
  assert.equal((await inject('DELETE', '/api/tasks/QIT-1/terminal')).statusCode, 200);
  assert.equal(await state('QIT-1'), 'gone');
  assert.equal((await inject('DELETE', '/api/tasks/QIT-2/terminal')).statusCode, 200);
});
